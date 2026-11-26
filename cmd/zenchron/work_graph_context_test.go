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
