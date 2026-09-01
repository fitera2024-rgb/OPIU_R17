package main

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestR001FailureMessageClassifiesSafeProcessAndPackageReasons(t *testing.T) {
	tests := []struct {
		name       string
		processErr error
		packageErr error
		want       string
	}{
		{
			name:       "deterministic process code",
			processErr: errors.New("FORCED_R001_FAILURE_AFTER_VALID_R005"),
			want:       "R001 не сформирован: принудительная проверочная ошибка после успешной R005",
		},
		{
			name:       "timeout",
			processErr: context.DeadlineExceeded,
			want:       "R001 не сформирован: превышен тайм-аут этапа R001",
		},
		{
			name:       "corrupt manifest",
			packageErr: errors.New(`read R001 manifest C:\private\user\run\manifest.json: invalid character`),
			want:       "R001 не сформирован: манифест R001 повреждён или нечитаем",
		},
		{
			name:       "hash mismatch",
			packageErr: errors.New(`registered R001 artifact hash mismatch: C:\private\user\Решения.xlsx`),
			want:       "R001 не сформирован: контрольная сумма файла R001 не совпадает",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := r001FailureMessage(test.processErr, test.packageErr)
			if got != test.want {
				t.Fatalf("message=%q want=%q", got, test.want)
			}
			if strings.Contains(got, `C:\private`) {
				t.Fatalf("private path leaked into user-visible reason: %q", got)
			}
		})
	}
}

func TestR001FailureMessageRejectsUnapprovedDiagnosticTokensAndSecrets(t *testing.T) {
	for _, unsafe := range []string{
		`R001_SECRET_API_KEY_ABCD1234`,
		`BLOCKED_R001_C:\private\user\run`,
		`FORCED_R001_ARBITRARY_PREFIX_TOKEN`,
		`R001_PASSWORD_SUPERSECRET`,
	} {
		got := r001FailureMessage(errors.New(unsafe), nil)
		if got != "R001 не сформирован: процесс R001 завершился ошибкой; подробности сохранены в журнале запуска" {
			t.Fatalf("unapproved diagnostic token leaked: input=%q message=%q", unsafe, got)
		}
		if strings.Contains(got, unsafe) || strings.Contains(strings.ToLower(got), "secret") || strings.Contains(got, `C:\private`) {
			t.Fatalf("secret-like detail entered user-visible message: input=%q message=%q", unsafe, got)
		}
	}
}
