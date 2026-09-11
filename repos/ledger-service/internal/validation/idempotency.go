// Package validation holds the integrity checks the ledger performs at write
// time. Business policy (limits, sanctions, currency) is NOT here: it lives in
// the transaction-validation-service repository.
package validation

import (
	"context"
	"errors"

	"github.com/acme-bank/ledger-service/internal/ledger"
)

// ErrMissingIdempotencyKey is returned when a caller omits the header.
var ErrMissingIdempotencyKey = errors.New("missing_idempotency_key")

const minKeyLength = 8

// RequireIdempotencyKey rejects a posting request that could not be safely retried.
func RequireIdempotencyKey(key string) error {
	if len(key) < minKeyLength {
		return ErrMissingIdempotencyKey
	}
	return nil
}

// LookupReplay reports whether this key has already produced a posting. The
// gateway retries aggressively on timeouts, so replays are routine traffic and
// must never create a second set of entries.
func LookupReplay(ctx context.Context, store *ledger.Store, key string) (ledger.Posting, bool, error) {
	posting, err := store.PostingByIdempotencyKey(ctx, key)
	if err != nil {
		return ledger.Posting{}, false, err
	}
	if posting.TransactionID == "" {
		return ledger.Posting{}, false, nil
	}
	return posting, true, nil
}
