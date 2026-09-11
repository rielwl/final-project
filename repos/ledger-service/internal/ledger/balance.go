package ledger

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// Store is the persistence boundary for the ledger.
type Store struct {
	db *sql.DB
}

// OpenStore connects to Postgres using the DATABASE_URL connection string.
func OpenStore(dsn string) (*Store, error) {
	if dsn == "" {
		dsn = "postgres://ledger:ledger@localhost:5432/ledger?sslmode=disable"
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, err
	}
	return &Store{db: db}, nil
}

// Close releases the connection pool.
func (s *Store) Close() error { return s.db.Close() }

// Balance returns the materialised balance in minor units. This is the read
// that transaction-validation-service makes for the INSUFFICIENT_FUNDS rule.
func (s *Store) Balance(ctx context.Context, iban string) (int64, error) {
	const query = "SELECT balance_minor FROM accounts WHERE iban = $1"
	var balance int64
	err := s.db.QueryRowContext(ctx, query, iban).Scan(&balance)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrAccountNotFound
	}
	return balance, err
}

// DailyTotal sums outbound postings over the rolling 24 hour window. The
// validation service uses this for the LIMIT_DAILY rule.
func (s *Store) DailyTotal(ctx context.Context, iban string) (int64, error) {
	const query = "SELECT -SUM(amount_minor) FROM entries WHERE iban = $1 AND amount_minor < 0 AND created_at >= $2"
	since := time.Now().UTC().Add(-24 * time.Hour)
	var total sql.NullInt64
	if err := s.db.QueryRowContext(ctx, query, iban, since).Scan(&total); err != nil {
		return 0, err
	}
	if !total.Valid {
		return 0, nil
	}
	return total.Int64, nil
}
