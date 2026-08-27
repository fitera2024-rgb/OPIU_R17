async function downloadServiceJournalFile(url, filename, emptyMessage) {
  const status = document.getElementById("diagnosticsStatus");
  if (status) status.textContent = "Получаем журнал сервиса…";
  try {
    const response = await fetch(url);
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || emptyMessage);
    }
    const blob = await response.blob();
    if (typeof downloadBlob === "function") {
      downloadBlob(blob, filename);
    } else {
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
    }
    if (status) status.textContent = `${filename} скачан.`;
  } catch (error) {
    if (typeof pushDiagnosticEvent === "function") {
      pushDiagnosticEvent("service_journal.download_failed", { url, message: error.message }, "error");
    }
    if (status) status.textContent = `${error.message}. Если сервис упал, перезапустите его и повторите скачивание — журнал остаётся на диске.`;
  }
}

document.getElementById("downloadServiceJournal")?.addEventListener("click", () => {
  downloadServiceJournalFile("/api/service-journal", "OPIU_SERVICE_RUNTIME.log", "Журнал сервиса недоступен");
});

document.getElementById("downloadCrashJournal")?.addEventListener("click", () => {
  downloadServiceJournalFile("/api/service-crash-journal", "OPIU_SERVICE_CRASH.log", "Журнал падений пока пуст");
});
