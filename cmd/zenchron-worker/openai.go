package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

const (
	maxAgentToolRounds = 6
	maxModelResponse   = 1 << 20
	maxToolCalls       = 5
	maxModelTokens     = 1200
)

type chatMessage struct {
	Role       string         `json:"role"`
	Content    any            `json:"content,omitempty"`
	Name       string         `json:"name,omitempty"`
	ToolCallID string         `json:"tool_call_id,omitempty"`
	ToolCalls  []chatToolCall `json:"tool_calls,omitempty"`
}

type chatToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type chatTool struct {
	Type     string `json:"type"`
	Function struct {
		Name        string          `json:"name"`
		Description string          `json:"description"`
		Parameters  json.RawMessage `json:"parameters"`
	} `json:"function"`
}

func (runtime *agentRuntime) complete(ctx context.Context, command workerapi.AgentRunCommand, repository string) (string, error) {
	if strings.TrimSpace(command.Profile.Model) == "" {
		return "", errors.New("agent profile has no model identifier")
	}
	systemPrompt := strings.TrimSpace(command.Profile.SystemPrompt)
	if goal := strings.TrimSpace(command.Profile.GoalPrompt); goal != "" {
		if systemPrompt != "" {
			systemPrompt += "\n\n"
		}
		systemPrompt += "Goal: " + goal
	}
	tools := agentChatTools(command.Profile.Tools)
	messages := []chatMessage{{Role: "system", Content: systemPrompt}, {Role: "user", Content: command.Prompt}}
	for round := 0; round < maxAgentToolRounds; round++ {
		answer, err := runtime.chat(ctx, command.Profile.Model, messages, tools)
		if err != nil {
			return "", err
		}
		if len(answer.ToolCalls) == 0 {
			output, ok := answer.Content.(string)
			if !ok || strings.TrimSpace(output) == "" {
				return "", errors.New("model returned an empty response")
			}
			return output, nil
		}
		if len(answer.ToolCalls) > maxToolCalls {
			return "", fmt.Errorf("model requested %d tools; maximum is %d", len(answer.ToolCalls), maxToolCalls)
		}
		messages = append(messages, answer)
		for _, call := range answer.ToolCalls {
			if call.ID == "" || call.Function.Name == "" {
				return "", errors.New("model returned an invalid tool call")
			}
			result, toolErr := executeAgentTool(ctx, repository, command.Profile.Tools, call.Function.Name, call.Function.Arguments)
			if toolErr != nil {
				result = "Tool error: request rejected or could not be completed."
			}
			if len(result) > maxAgentToolOutput {
				result = result[:maxAgentToolOutput]
			}
			messages = append(messages, chatMessage{Role: "tool", ToolCallID: call.ID, Content: result})
		}
	}
	return "", errors.New("model exceeded the tool-call round limit")
}

func (runtime *agentRuntime) chat(
	ctx context.Context, model string, messages []chatMessage, tools []chatTool,
) (chatMessage, error) {
	toolChoice := ""
	if len(tools) > 0 {
		toolChoice = "auto"
	}
	body, err := json.Marshal(struct {
		Model      string        `json:"model"`
		Messages   []chatMessage `json:"messages"`
		Tools      []chatTool    `json:"tools,omitempty"`
		ToolChoice string        `json:"tool_choice,omitempty"`
		MaxTokens  int           `json:"max_tokens"`
	}{Model: model, Messages: messages, Tools: tools, ToolChoice: toolChoice, MaxTokens: maxModelTokens})
	if err != nil {
		return chatMessage{}, fmt.Errorf("encode chat request: %w", err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, runtime.endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return chatMessage{}, fmt.Errorf("create chat request: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	if runtime.apiKey != "" {
		request.Header.Set("Authorization", "Bearer "+runtime.apiKey)
	}
	response, err := runtime.client.Do(request)
	if err != nil {
		return chatMessage{}, fmt.Errorf("send chat request: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return chatMessage{}, fmt.Errorf("chat completion returned HTTP %d", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxModelResponse+1))
	if err != nil {
		return chatMessage{}, fmt.Errorf("read chat response: %w", err)
	}
	if len(data) > maxModelResponse {
		return chatMessage{}, errors.New("chat response exceeded the size limit")
	}
	var result struct {
		Choices []struct {
			Message chatMessage `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(data, &result); err != nil {
		return chatMessage{}, fmt.Errorf("decode chat response: %w", err)
	}
	if len(result.Choices) == 0 {
		return chatMessage{}, errors.New("chat response contains no choices")
	}
	return result.Choices[0].Message, nil
}

func agentChatTools(allowed []string) []chatTool {
	all := map[string]chatTool{
		"code.search": makeChatTool("code.search", "Search repository source files by a literal query.", `{"type":"object","properties":{"query":{"type":"string"}},"required":["query"],"additionalProperties":false}`),
		"code.write":  makeChatTool("code.write", "Write one repository file on this run's isolated Git branch.", `{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"],"additionalProperties":false}`),
		"docs.search": makeChatTool("docs.search", "Search repository documentation by a literal query.", `{"type":"object","properties":{"query":{"type":"string"}},"required":["query"],"additionalProperties":false}`),
		"git.diff":    makeChatTool("git.diff", "Read tracked changes in the repository worktree.", `{"type":"object","properties":{},"additionalProperties":false}`),
		"git.read":    makeChatTool("git.read", "Read a repository file by relative path.", `{"type":"object","properties":{"path":{"type":"string"}},"required":["path"],"additionalProperties":false}`),
	}
	tools := make([]chatTool, 0, len(allowed))
	for _, name := range allowed {
		if tool, supported := all[name]; supported {
			tools = append(tools, tool)
		}
	}
	return tools
}

func makeChatTool(name, description, parameters string) chatTool {
	var tool chatTool
	tool.Type, tool.Function.Name, tool.Function.Description = "function", name, description
	tool.Function.Parameters = json.RawMessage(parameters)
	return tool
}
