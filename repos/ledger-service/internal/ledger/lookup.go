package ledger

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
)

// PostingByIdempotencyKey returns the posting previously written under key, if
// any. An empty TransactionID means the key has never been used.
func (s *Store) PostingByIdempotencyKey(ctx context.Context, key string) (Posting, error) {
	const query = "SELECT transaction_id, created_at, ABS(amount_minor) FROM entries WHERE idempotency_key = $1 AND amount_minor > 0 LIMIT 1"
	var p Posting
	err := s.db.QueryRowContext(ctx, query, key).Scan(&p.TransactionID, &p.PostedAt, &p.AmountMinor)
	if errors.Is(err, sql.ErrNoRows) {
		return Posting{}, nil
	}
	p.PaymentID = p.TransactionID
	return p, err
}

func newID() string {
	buf := make([]byte, 16)
	_, _ = rand.Read(buf)
	return hex.EncodeToString(buf)
}
