package main

import (
	"log"
	"net/http"
	"os"

	"github.com/acme-bank/ledger-service/internal/api"
	"github.com/acme-bank/ledger-service/internal/ledger"
)

func main() {
	store, err := ledger.OpenStore(os.Getenv("DATABASE_URL"))
	if err != nil {
		log.Fatalf("open store: %v", err)
	}
	defer store.Close()

	port := os.Getenv("PORT")
	if port == "" {
		port = "8082"
	}

	handler := api.NewRouter(store)
	log.Printf("ledger-service listening on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, handler))
}
