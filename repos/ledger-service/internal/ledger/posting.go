package ledger

import (
	"context"
	"errors"
	"fmt"
	"time"
)

var (
	// ErrInsufficientFunds is returned when the debtor balance would go negative.
	ErrInsufficientFunds = errors.New("insufficient funds")
	// ErrAccountNotFound is returned for an unknown IBAN.
	ErrAccountNotFound = errors.New("account not found")
	// ErrUnbalanced means debits did not equal credits; this is a bug, not a
	// business outcome, and always rolls the transaction back.
	ErrUnbalanced = errors.New("entries do not balance")
)

// Transfer is one movement of money between two accounts.
type Transfer struct {
	IdempotencyKey  string
	AmountMinor     int64
	Currency        string
	DebtorAccount   string
	CreditorAccount string
	ValidationRef   string
}

// Posting is the persisted result of a Transfer.
type Posting struct {
	PaymentID     string    `json:"paymentId"`
	TransactionID string    `json:"transactionId"`
	PostedAt      time.Time `json:"postedAt"`
	AmountMinor   int64     `json:"amountMinor"`
}

// PostTransfer writes the debit and credit entries atomically.
//
// Three checks happen inside the write transaction because only here can they
// be made race-free: the idempotency key is claimed, the debtor balance is
// re-read under a row lock, and the entries are asserted to sum to zero.
func (s *Store) PostTransfer(ctx context.Context, t Transfer) (Posting, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Posting{}, fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var balance int64
	row := tx.QueryRowContext(ctx,
		"SELECT balance_minor FROM accounts WHERE iban = $1 FOR UPDATE", t.DebtorAccount)
	if err := row.Scan(&balance); err != nil {
		return Posting{}, ErrAccountNotFound
	}

	// Final sufficiency check. transaction-validation-service checked this a few
	// milliseconds ago, but a concurrent posting may have drained the account.
	if balance < t.AmountMinor {
		return Posting{}, ErrInsufficientFunds
	}

	transactionID := newID()
	entries := []entry{
		{TransactionID: transactionID, IBAN: t.DebtorAccount, AmountMinor: -t.AmountMinor},
		{TransactionID: transactionID, IBAN: t.CreditorAccount, AmountMinor: t.AmountMinor},
	}
	if !balanced(entries) {
		return Posting{}, ErrUnbalanced
	}

	const insertEntry = "INSERT INTO entries (transaction_id, iban, amount_minor, currency, validation_ref, idempotency_key) VALUES ($1, $2, $3, $4, $5, $6)"
	const updateBalance = "UPDATE accounts SET balance_minor = balance_minor + $1 WHERE iban = $2"

	for _, e := range entries {
		if _, err := tx.ExecContext(ctx, insertEntry,
			e.TransactionID, e.IBAN, e.AmountMinor, t.Currency, t.ValidationRef, t.IdempotencyKey); err != nil {
			return Posting{}, fmt.Errorf("insert entry: %w", err)
		}
		if _, err := tx.ExecContext(ctx, updateBalance, e.AmountMinor, e.IBAN); err != nil {
			return Posting{}, fmt.Errorf("update balance: %w", err)
		}
	}

	if err := tx.Commit(); err != nil {
		return Posting{}, fmt.Errorf("commit: %w", err)
	}

	return Posting{
		PaymentID:     transactionID,
		TransactionID: transactionID,
		PostedAt:      time.Now().UTC(),
		AmountMinor:   t.AmountMinor,
	}, nil
}

type entry struct {
	TransactionID string
	IBAN          string
	AmountMinor   int64
}

// balanced asserts the core double-entry invariant.
func balanced(entries []entry) bool {
	var sum int64
	for _, e := range entries {
		sum += e.AmountMinor
	}
	return sum == 0
}
