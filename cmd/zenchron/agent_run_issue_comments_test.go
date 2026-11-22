package main

import (
	"fmt"
	"strings"
	"testing"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

func TestIssueRunIncludesLatestCommentsBeyondFirstFifty(t *testing.T) {
	harness := newDeliveryHarness(t, workerapi.ProviderCodex)
	harness.issueComments = make([]string, 151)
	for index := range harness.issueComments {
		harness.issueComments[index] = fmt.Sprintf(`{"body":"Comment %02d","author_association":"OWNER","user":{"login":"maintainer"}}`, index)
	}
	harness.issueComments[150] = `{"body":"Latest maintainer clarification","author_association":"OWNER","user":{"login":"maintainer"}}`
	run := harness.createIssueRun()
	if context := harness.run(run.ID).IssueContext; !strings.Contains(context, "Latest maintainer clarification") ||
		!strings.Contains(context, "truncated") {
		t.Fatalf("latest issue comment is missing from context: %s", context)
	}
}

func TestIssueRunContextMarksOmittedCommentsAndKeepsNewest(t *testing.T) {
	comments := make([]gitHubIssueComment, 8)
	for index := range comments {
		comments[index].Body = strings.Repeat(fmt.Sprintf("comment %d ", index), 180)
		comments[index].AuthorAssociation = "MEMBER"
		comments[index].User.Login = "maintainer"
	}
	context := issueContextWithComments("Issue body", comments, false)
	if len(context) > maxIssueContextSize || !strings.Contains(context, "truncated") ||
		!strings.Contains(context, "comment 7") || strings.Contains(context, "comment 0") {
		t.Fatalf("bounded issue context = %d bytes: %q", len(context), context)
	}
	pageBounded := issueContextWithComments("Issue body", comments[:1], true)
	if !strings.Contains(pageBounded, "truncated") || !strings.Contains(pageBounded, "comment 0") {
		t.Fatalf("page-bounded issue context = %q", pageBounded)
	}
}

func TestIssueRunPreservesNewestHundredCommentsAtPageBoundaries(t *testing.T) {
	for _, total := range []int{101, 151, 199, 201} {
		t.Run(fmt.Sprint(total), func(t *testing.T) {
			harness := newDeliveryHarness(t, workerapi.ProviderCodex)
			harness.issueComments = make([]string, total)
			for index := range harness.issueComments {
				harness.issueComments[index] = fmt.Sprintf(
					`{"body":"Marker-%03d","author_association":"OWNER","user":{"login":"maintainer"}}`, index)
			}
			run := harness.createIssueRun()
			context := harness.run(run.ID).IssueContext
			for index := total - 100; index < total; index++ {
				if !strings.Contains(context, fmt.Sprintf("Marker-%03d", index)) {
					t.Fatalf("latest comment %d was omitted from issue context", index)
				}
			}
			if strings.Contains(context, fmt.Sprintf("Marker-%03d", total-101)) {
				t.Fatal("oldest comment was included instead of the newest 100")
			}
			if !strings.Contains(context, "truncated") {
				t.Fatal("omitted earlier comments were not reported")
			}
		})
	}
}
