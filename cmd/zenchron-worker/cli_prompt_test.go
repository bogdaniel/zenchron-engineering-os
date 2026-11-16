package main

import (
	"strings"
	"testing"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

func TestCLIPromptComposesPersonaBeforeProfileAndTaskWithoutChangingTools(t *testing.T) {
	command := workerapi.AgentRunCommand{Prompt: "Implement the fix", Profile: workerapi.AgentProfile{
		SystemPrompt: "Profile system", GoalPrompt: "Profile goal", Tools: []string{"git.read"},
		Persona: &workerapi.AgentPersona{ID: "persona-1", Name: "Reviewer", Role: "Find defects", Version: 4,
			Responsibilities: []string{"Inspect authorization"}, Instructions: "Trace input validation",
			Behavior: "State evidence", ReviewSpecialization: "Access control"},
	}}
	prompt := cliPrompt(command)
	ordered := []string{"Persona: Reviewer (version 4)", "Role: Find defects", "Responsibility: Inspect authorization",
		"Persona instructions: Trace input validation", "Behavior: State evidence", "Review specialization: Access control",
		"Profile system", "Goal: Profile goal", "Implement the fix", cliOperatingContract}
	last := -1
	for _, part := range ordered {
		index := strings.Index(prompt, part)
		if index <= last {
			t.Fatalf("prompt does not preserve composition order at %q: %q", part, prompt)
		}
		last = index
	}
	if len(command.Profile.Tools) != 1 || command.Profile.Tools[0] != "git.read" {
		t.Fatalf("persona changed profile tools: %#v", command.Profile.Tools)
	}
}
