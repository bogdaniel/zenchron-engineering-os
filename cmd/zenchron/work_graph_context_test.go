package main

import (
	"strings"
	"testing"
)

// The validator rejects a unit whose agent lacks a listed capability; the planner must be told that rule.
func TestPlannerContractRequiresAgentToOfferListedCapabilities(t *testing.T) {
	if !strings.Contains(plannerContract, "Every listed capability must be\n  among the tools of the unit's agent_id") {
		t.Fatal("planner contract does not state that an agent must offer every capability its unit lists")
	}
}

// Publication requires a review of the integrate unit; a plan without one can never open a pull request.
func TestPlannerContractRequiresAReviewOfTheIntegratedCandidate(t *testing.T) {
	if !strings.Contains(plannerContract, "add one review unit whose only dependency is the integrate unit") {
		t.Fatal("planner contract does not require a review of the integrated candidate")
	}
}
