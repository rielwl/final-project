package api

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/acme-bank/ledger-service/internal/ledger"
	"github.com/acme-bank/ledger-service/internal/validation"
)

// NewRouter wires the three endpoints other services depend on.
func NewRouter(store *ledger.Store) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/postings", postTransfer(store))
	mux.HandleFunc("GET /v1/accounts/{iban}/balance", getBalance(store))
	mux.HandleFunc("GET /v1/accounts/{iban}/daily-total", getDailyTotal(store))
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	return mux
}

type transferRequest struct {
	AmountMinor     int64  `json:"amountMinor"`
	Currency        string `json:"currency"`
	DebtorAccount   string `json:"debtorAccount"`
	CreditorAccount string `json:"creditorAccount"`
	ValidationRef   string `json:"validationRef"`
}

func postTransfer(store *ledger.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req transferRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad_json"})
			return
		}

		key := r.Header.Get("Idempotency-Key")
		if err := validation.RequireIdempotencyKey(key); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}

		// A replayed key is not an error: return the original posting with 409 so
		// the gateway can treat it as success without double-posting.
		if existing, found, err := validation.LookupReplay(r.Context(), store, key); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "lookup_failed"})
			return
		} else if found {
			writeJSON(w, http.StatusConflict, existing)
			return
		}

		posting, err := store.PostTransfer(r.Context(), ledger.Transfer{
			IdempotencyKey:  key,
			AmountMinor:     req.AmountMinor,
			Currency:        req.Currency,
			DebtorAccount:   req.DebtorAccount,
			CreditorAccount: req.CreditorAccount,
			ValidationRef:   req.ValidationRef,
		})
		switch {
		case errors.Is(err, ledger.ErrInsufficientFunds):
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "INSUFFICIENT_FUNDS"})
		case err != nil:
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "post_failed"})
		default:
			writeJSON(w, http.StatusCreated, posting)
		}
	}
}

func getBalance(store *ledger.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		balance, err := store.Balance(r.Context(), r.PathValue("iban"))
		if errors.Is(err, ledger.ErrAccountNotFound) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "account_not_found"})
			return
		}
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "balance_failed"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]int64{"balanceMinor": balance})
	}
}

func getDailyTotal(store *ledger.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		total, err := store.DailyTotal(r.Context(), r.PathValue("iban"))
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "daily_total_failed"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]int64{"totalMinor": total})
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
