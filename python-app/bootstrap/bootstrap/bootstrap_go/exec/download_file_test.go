package exec

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/ruigro/LLM-Studio/LLM/bootstrap/bootstrap_go/plan"
)

func TestValidateURL(t *testing.T) {
	cases := []struct {
		url    string
		wantOK bool
	}{
		{"https://example.com/x", true},
		{"http://example.com/x", false},
		{"ftp://example.com/x", false},
		{":bad-url", false},
	}
	for _, c := range cases {
		err := validateURL(c.url)
		if (err == nil) != c.wantOK {
			t.Errorf("validateURL(%q) ok=%v err=%v", c.url, err == nil, err)
		}
	}
}

func TestDownloadFile_HappyPath(t *testing.T) {
	body := []byte("payload")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write(body)
	}))
	defer srv.Close()

	t.Setenv("LOCALLLM_ALLOW_HTTP", "1")
	tmp := t.TempDir()
	dest := filepath.Join(tmp, "x.bin")
	step := plan.Step{
		Action: "download_file",
		Args:   map[string]any{"url": srv.URL, "dest": dest},
	}
	if err := DownloadFile(DownloadFileOpts{}, step); err != nil {
		t.Fatalf("unexpected: %v", err)
	}
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(body) {
		t.Errorf("body mismatch")
	}
}

func TestDownloadFile_HashMatchSkipsRedownload(t *testing.T) {
	body := []byte("first version")
	hash := sha256.Sum256(body)
	hexHash := hex.EncodeToString(hash[:])

	tmp := t.TempDir()
	dest := filepath.Join(tmp, "y.bin")
	if err := os.WriteFile(dest, body, 0o644); err != nil {
		t.Fatal(err)
	}

	// Server returns DIFFERENT body. If our short-circuit works, we
	// should NOT download it -- the file on disk already matches.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("DIFFERENT"))
	}))
	defer srv.Close()

	t.Setenv("LOCALLLM_ALLOW_HTTP", "1")
	step := plan.Step{
		Action: "download_file",
		Args: map[string]any{
			"url": srv.URL, "dest": dest, "sha256": hexHash,
		},
	}
	if err := DownloadFile(DownloadFileOpts{}, step); err != nil {
		t.Fatalf("unexpected: %v", err)
	}
	got, _ := os.ReadFile(dest)
	if string(got) != string(body) {
		t.Errorf("file was overwritten despite matching hash; got %q", got)
	}
}

func TestDownloadFile_HashMismatchFails(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("payload"))
	}))
	defer srv.Close()

	t.Setenv("LOCALLLM_ALLOW_HTTP", "1")
	tmp := t.TempDir()
	dest := filepath.Join(tmp, "z.bin")
	step := plan.Step{
		Action: "download_file",
		Args: map[string]any{
			"url":    srv.URL,
			"dest":   dest,
			"sha256": "0000000000000000000000000000000000000000000000000000000000000000",
		},
	}
	if err := DownloadFile(DownloadFileOpts{}, step); err == nil {
		t.Fatal("expected sha256 mismatch error")
	}
	// Failed download should not leave dest in place.
	if _, err := os.Stat(dest); err == nil {
		t.Error("dest should not exist after sha256 mismatch")
	}
}

func TestDownloadFile_404Errors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "not found", http.StatusNotFound)
	}))
	defer srv.Close()

	t.Setenv("LOCALLLM_ALLOW_HTTP", "1")
	dest := filepath.Join(t.TempDir(), "missing.bin")
	step := plan.Step{
		Action: "download_file",
		Args:   map[string]any{"url": srv.URL, "dest": dest},
	}
	if err := DownloadFile(DownloadFileOpts{}, step); err == nil {
		t.Fatal("expected 404 to error")
	}
}
