package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

// Unit kinds. A produce unit changes code through an agent, a review unit judges one exact candidate
// through an independent read-only agent, and the integrate unit combines every produced candidate
// deterministically on the worker and publishes the single pull request.
const (
	unitProduce   = "produce"
	unitReview    = "review"
	unitIntegrate = "integrate"
)

const (
	maxPlanUnits        = 8
	maxUnitKeySize      = 32
	maxPlanParallel     = 4
	defaultPlanParallel = 2
	maxUnitAcceptance   = 8
	// maxPlanRevisions bounds the plan history of one objective, and with it the size of the snapshot.
	maxPlanRevisions = 20

	planPlanning   = "planning"
	planProposed   = "proposed"
	planInvalid    = "invalid"
	planApproved   = "approved"
	planSuperseded = "superseded"

	workflowModeCompiled = "compiled"
	workflowModeGuidance = "guidance"
)

var unitKeyPattern = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)

// planUnit is one bounded responsibility of an engineering plan.
type planUnit struct {
	Key          string   `json:"key"`
	Kind         string   `json:"kind"`
	Title        string   `json:"title"`
	Instructions string   `json:"instructions"`
	Acceptance   []string `json:"acceptance"`
	DependsOn    []string `json:"depends_on"`
	// Capabilities are the agent tools the responsibility needs; the assigned profile must offer them.
	Capabilities []string `json:"capabilities"`
	// AgentID is the agent profile assigned to the unit. The integrate unit has none.
	AgentID        string `json:"agent_id,omitempty"`
	ProfileVersion int    `json:"profile_version,omitempty"`
	PersonaID      string `json:"persona_id,omitempty"`
	PersonaVersion int    `json:"persona_version,omitempty"`
}

// planProposal is the part of a plan a planner model or an operator writes. Nothing in it executes
// until problems reports it valid and a user approves it.
type planProposal struct {
	Summary     string     `json:"summary"`
	MaxParallel int        `json:"max_parallel"`
	Units       []planUnit `json:"units"`
}

// objectivePlan is one revision of the engineering plan of an objective.
type objectivePlan struct {
	planProposal
	ObjectiveID string `json:"objective_id"`
	Revision    int    `json:"revision"`
	Status      string `json:"status"`
	ProjectID   string `json:"project_id"`
	// ProductContext is the linked product identity and description frozen when this plan revision is proposed.
	ProductContext                string `json:"product_context,omitempty"`
	ProductConfigurationRevision  int    `json:"product_configuration_revision,omitempty"`
	ProductKnowledgeRevision      int    `json:"product_knowledge_revision,omitempty"`
	OrganizationKnowledgeRevision int    `json:"organization_knowledge_revision,omitempty"`
	// Repository is the repository of the project when the plan was proposed; reading the plan needs a grant for it.
	Repository       string                  `json:"repository,omitempty"`
	WorkflowID       string                  `json:"workflow_id,omitempty"`
	WorkflowVersion  int                     `json:"workflow_version,omitempty"`
	WorkflowMode     string                  `json:"workflow_mode,omitempty"`
	WorkflowGuidance string                  `json:"workflow_guidance,omitempty"`
	ProfileSnapshots map[string]agentProfile `json:"profile_snapshots,omitempty"`
	// Hash identifies the plan's content, so an unchanged plan is recognized and not approved twice.
	Hash string `json:"hash,omitempty"`
	// Problems says why a proposal is invalid.
	Problems     []string `json:"problems,omitempty"`
	PlannerRunID string   `json:"planner_run_id,omitempty"`
	// SourceCheckRunID is the worker run verifying the plan's source against origin before approval.
	SourceCheckRunID string `json:"source_check_run_id,omitempty"`
	// SourceCheckError says why the last source check refused approval.
	SourceCheckError string     `json:"source_check_error,omitempty"`
	GraphID          string     `json:"graph_id,omitempty"`
	CreatedBy        string     `json:"created_by,omitempty"`
	CreatedAt        time.Time  `json:"created_at"`
	ApprovedBy       string     `json:"approved_by,omitempty"`
	ApprovedAt       *time.Time `json:"approved_at,omitempty"`
}

// problems normalizes a proposal and returns every reason it must not execute: malformed units, unknown
// or cyclic dependencies, assignments to profiles that lack the needed permissions, reviewers that are
// not independent, and work that would never reach the integrated candidate. An empty result is the
// only thing that makes a proposal approvable.
func (proposal *planProposal) problems(agents map[string]agentProfile) []string {
	var problems []string
	add := func(format string, arguments ...any) { problems = append(problems, fmt.Sprintf(format, arguments...)) }
	proposal.Summary = strings.TrimSpace(proposal.Summary)
	if proposal.MaxParallel == 0 {
		proposal.MaxParallel = defaultPlanParallel
	}
	if proposal.MaxParallel < 1 || proposal.MaxParallel > maxPlanParallel {
		add("max_parallel must be between 1 and %d", maxPlanParallel)
	}
	if len(proposal.Summary) > 2000 {
		add("summary exceeds 2000 bytes")
	}
	if len(proposal.Units) == 0 || len(proposal.Units) > maxPlanUnits {
		return append(problems, fmt.Sprintf("a plan needs between 1 and %d units", maxPlanUnits))
	}
	units := make(map[string]planUnit, len(proposal.Units))
	for index := range proposal.Units {
		unit := &proposal.Units[index]
		unit.Key, unit.Title = strings.TrimSpace(unit.Key), strings.TrimSpace(unit.Title)
		unit.Instructions, unit.AgentID = strings.TrimSpace(unit.Instructions), strings.ToLower(strings.TrimSpace(unit.AgentID))
		if !unitKeyPattern.MatchString(unit.Key) || len(unit.Key) > maxUnitKeySize {
			add("unit %d needs a key of lowercase letters, digits, and dashes, at most %d bytes", index+1, maxUnitKeySize)
			continue
		}
		if _, duplicate := units[unit.Key]; duplicate {
			add("unit key %q is used twice", unit.Key)
		}
		units[unit.Key] = *unit
		if unit.Kind != unitProduce && unit.Kind != unitReview && unit.Kind != unitIntegrate {
			add("unit %q has kind %q; the kinds are produce, review, and integrate", unit.Key, unit.Kind)
		}
		if unit.Title == "" || len(unit.Title) > 200 || len(unit.Instructions) > 4000 {
			add("unit %q needs a title of at most 200 bytes and instructions of at most 4000 bytes", unit.Key)
		}
		if len(unit.Acceptance) > maxUnitAcceptance || slices.ContainsFunc(unit.Acceptance, func(criterion string) bool {
			return strings.TrimSpace(criterion) == "" || len(criterion) > 300
		}) {
			add("unit %q may list at most %d acceptance criteria of 1 to 300 bytes", unit.Key, maxUnitAcceptance)
		}
		if !validAgentTools(unit.Capabilities) {
			add("unit %q lists an unknown or repeated capability", unit.Key)
		}
	}
	if len(problems) > 0 {
		return problems
	}
	for _, unit := range proposal.Units {
		seen := map[string]bool{}
		for _, dependency := range unit.DependsOn {
			if _, exists := units[dependency]; !exists || dependency == unit.Key || seen[dependency] {
				add("unit %q depends on %q, which is unknown, repeated, or the unit itself", unit.Key, dependency)
			}
			seen[dependency] = true
		}
	}
	if len(problems) > 0 {
		return problems
	}
	if cycle := dependencyCycle(proposal.Units); len(cycle) > 0 {
		return append(problems, "dependencies form a cycle through "+strings.Join(cycle, ", "))
	}
	return proposal.assignmentProblems(units, agents)
}

// assignmentProblems checks what each kind of unit may depend on and who may execute it. The
// dependencies are already known to exist and to be acyclic.
func (proposal *planProposal) assignmentProblems(units map[string]planUnit, agents map[string]agentProfile) []string {
	var problems []string
	add := func(format string, arguments ...any) { problems = append(problems, fmt.Sprintf(format, arguments...)) }
	integrators := 0
	for _, unit := range proposal.Units {
		kinds := map[string]int{}
		for _, dependency := range unit.DependsOn {
			kinds[units[dependency].Kind]++
		}
		switch unit.Kind {
		case unitProduce:
			// A producer that depends on another producer builds on that candidate's branch, so it can
			// build on only one.
			if kinds[unitProduce] > 1 || kinds[unitIntegrate] > 0 {
				add("unit %q may build on at most one produce unit and never on the integrate unit", unit.Key)
			}
			if reason := assignmentProblem(unit, agents, true); reason != "" {
				add("unit %q %s", unit.Key, reason)
			}
		case unitReview:
			if len(unit.DependsOn) != 1 || kinds[unitReview] > 0 {
				add("unit %q must review exactly one produce or integrate unit", unit.Key)
				continue
			}
			if reason := assignmentProblem(unit, agents, false); reason != "" {
				add("unit %q %s", unit.Key, reason)
			}
			for _, producer := range proposal.reviewedProducers(units[unit.DependsOn[0]]) {
				if producer.AgentID == unit.AgentID {
					add("unit %q reviews work of its own agent profile in %q; a reviewer must be independent", unit.Key, producer.Key)
				}
			}
		case unitIntegrate:
			integrators++
			if unit.AgentID != "" || len(unit.Capabilities) > 0 {
				add("unit %q is executed by Zenchron itself and takes no agent or capabilities", unit.Key)
			}
			if kinds[unitIntegrate] > 0 {
				add("unit %q cannot depend on another integrate unit", unit.Key)
			}
			for _, producer := range proposal.Units {
				if producer.Kind == unitProduce && !reaches(units, unit.Key, producer.Key) {
					add("produce unit %q never reaches the integrate unit, so its work would be lost", producer.Key)
				}
			}
		}
	}
	if !slices.ContainsFunc(proposal.Units, func(unit planUnit) bool { return unit.Kind == unitProduce }) {
		add("a plan needs at least one produce unit")
	}
	if integrators != 1 {
		add("a plan needs exactly one integrate unit, which combines the produced work and publishes the pull request")
	}
	return problems
}

// reviewedProducers returns the produce units whose work a review of target judges.
func (proposal *planProposal) reviewedProducers(target planUnit) []planUnit {
	if target.Kind == unitProduce {
		return []planUnit{target}
	}
	return slices.DeleteFunc(slices.Clone(proposal.Units), func(unit planUnit) bool { return unit.Kind != unitProduce })
}

// assignmentProblem says why a unit's agent profile cannot execute it. A producer needs a profile that
// may write code; a reviewer needs one that may not, so a review can never change its subject.
func assignmentProblem(unit planUnit, agents map[string]agentProfile, writes bool) string {
	profile, exists := agents[unit.AgentID]
	switch {
	case !exists:
		return "is assigned to an agent profile that does not exist"
	case profile.Status != "active":
		return fmt.Sprintf("is assigned to the disabled agent profile %q", profile.Name)
	case profile.PersonaID != "" && (profile.PersonaSnapshot == nil || profile.PersonaSnapshot.Status != "active"):
		return fmt.Sprintf("is assigned to %q, whose linked persona is unavailable", profile.Name)
	case unit.ProfileVersion != 0 && unit.ProfileVersion != profile.Version:
		return fmt.Sprintf("is assigned to %q at profile version %d, current version is %d", profile.Name, unit.ProfileVersion, profile.Version)
	case unit.PersonaID != profile.PersonaID:
		return fmt.Sprintf("is assigned to %q with persona %q, expected %q", profile.Name, profile.PersonaID, unit.PersonaID)
	case unit.PersonaVersion != 0 && (profile.PersonaSnapshot == nil || unit.PersonaVersion != profile.PersonaSnapshot.Version):
		return fmt.Sprintf("is assigned to %q at persona version %d, current version differs", profile.Name, unit.PersonaVersion)
	case !workerapi.IsCLIProvider(profile.Provider):
		return fmt.Sprintf("is assigned to %q, whose provider has no execution adapter", profile.Name)
	case writes && !slices.Contains(profile.Tools, "code.write"):
		return fmt.Sprintf("produces code but %q may not write code", profile.Name)
	case !writes && slices.Contains(profile.Tools, "code.write"):
		return fmt.Sprintf("reviews code but %q may write code; assign a read-only profile", profile.Name)
	}
	for _, capability := range unit.Capabilities {
		if !slices.Contains(profile.Tools, capability) {
			return fmt.Sprintf("needs %s, which %q does not offer", capability, profile.Name)
		}
	}
	return ""
}

func pinPlanProfiles(proposal *planProposal, profiles map[string]agentProfile) (map[string]agentProfile, []string) {
	snapshots := make(map[string]agentProfile)
	var problems []string
	for index := range proposal.Units {
		unit := &proposal.Units[index]
		if unit.Kind == unitIntegrate {
			continue
		}
		profile, exists := profiles[unit.AgentID]
		if !exists {
			continue
		}
		if unit.ProfileVersion != 0 && unit.ProfileVersion != profile.Version {
			problems = append(problems, fmt.Sprintf("unit %q refers to stale profile version %d; current version is %d", unit.Key, unit.ProfileVersion, profile.Version))
		}
		if unit.PersonaID != "" && unit.PersonaID != profile.PersonaID {
			problems = append(problems, fmt.Sprintf("unit %q refers to persona %q, but profile %q is bound to %q", unit.Key, unit.PersonaID, profile.Name, profile.PersonaID))
		}
		if unit.PersonaVersion != 0 && (profile.PersonaSnapshot == nil || unit.PersonaVersion != profile.PersonaSnapshot.Version) {
			problems = append(problems, fmt.Sprintf("unit %q refers to a stale persona version", unit.Key))
		}
		unit.ProfileVersion, unit.PersonaID = profile.Version, profile.PersonaID
		if profile.PersonaSnapshot != nil {
			unit.PersonaVersion = profile.PersonaSnapshot.Version
		} else {
			unit.PersonaVersion = 0
		}
		profile.Tools = slices.Clone(profile.Tools)
		if profile.PersonaSnapshot != nil {
			persona := *profile.PersonaSnapshot
			persona.Responsibilities = slices.Clone(persona.Responsibilities)
			profile.PersonaSnapshot = &persona
		}
		snapshots[profile.ID] = profile
	}
	return snapshots, problems
}

// dependencyCycle returns the keys of units that can never start because their dependencies form a
// cycle, in plan order, or nothing when the graph is acyclic.
func dependencyCycle(units []planUnit) []string {
	done := map[string]bool{}
	for progressed := true; progressed; {
		progressed = false
		for _, unit := range units {
			if !done[unit.Key] && !slices.ContainsFunc(unit.DependsOn, func(key string) bool { return !done[key] }) {
				done[unit.Key], progressed = true, true
			}
		}
	}
	var cycle []string
	for _, unit := range units {
		if !done[unit.Key] {
			cycle = append(cycle, unit.Key)
		}
	}
	return cycle
}

// reaches reports whether from depends on target, directly or through other units of an acyclic plan.
func reaches(units map[string]planUnit, from, target string) bool {
	return slices.ContainsFunc(units[from].DependsOn, func(dependency string) bool {
		return dependency == target || reaches(units, dependency, target)
	})
}

// planHash identifies what a plan would execute and where.
func planHash(projectID, workflowID string, workflowVersion int, workflowMode, productContext string,
	productConfigurationRevision int, proposal planProposal) string {
	// Encoding plain strings, integers, and slices cannot fail.
	data, _ := json.Marshal(struct {
		ProjectID                    string       `json:"project_id"`
		WorkflowID                   string       `json:"workflow_id"`
		WorkflowVersion              int          `json:"workflow_version"`
		WorkflowMode                 string       `json:"workflow_mode,omitempty"`
		ProductContext               string       `json:"product_context,omitempty"`
		ProductConfigurationRevision int          `json:"product_configuration_revision,omitempty"`
		Proposal                     planProposal `json:"proposal"`
	}{projectID, workflowID, workflowVersion, workflowMode, productContext, productConfigurationRevision, proposal})
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}
