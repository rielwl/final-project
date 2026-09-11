package ledger

import "testing"

func TestBalancedRequiresDebitsToEqualCredits(t *testing.T) {
	entries := []entry{
		{TransactionID: "t1", IBAN: "GB33BUKB20201555555555", AmountMinor: -2500},
		{TransactionID: "t1", IBAN: "FR7630006000011234567890189", AmountMinor: 2500},
	}
	if !balanced(entries) {
		t.Fatal("expected a debit and matching credit to balance")
	}
}

func TestBalancedRejectsMismatchedEntries(t *testing.T) {
	entries := []entry{
		{TransactionID: "t2", IBAN: "GB33BUKB20201555555555", AmountMinor: -2500},
		{TransactionID: "t2", IBAN: "FR7630006000011234567890189", AmountMinor: 2400},
	}
	if balanced(entries) {
		t.Fatal("expected mismatched entries to be rejected")
	}
}

