# EndoCode

EndoCode to desktopowa aplikacja Electron do pracy z lokalnym agentem kodującym (GGUF + llama.cpp), z naciskiem na:
- szybki workflow patch-first,
- transparentny podglad krokow agenta,
- lokalne narzedzia i lokalne pliki.

## Podglad aplikacji

<img width="1261" height="849" alt="app-screenshot" src="https://github.com/user-attachments/assets/34c894b3-a254-412a-81cd-b1b0cd794f81" />

## Co potrafi

- Chat i tryb agentowy (planowanie -> narzedzia -> final)
- Praca na plikach: odczyt, zapis, patchowanie, diff i historia undo/redo
- Integracja z lokalnym runtime (`llama-server`)
- Zarzadzanie modelami GGUF (biblioteka, pobieranie, anulowanie pobierania)
- Konfiguracja parametrow modelu z poziomu UI

## Struktura i wymagania

EndoCode zaklada projektowy layout katalogow w repo:

```text
EndoCode/
  app/
  config/
  models/
  runtime/
```

Najwazniejsze:
- konfiguracja modeli: `config/models.json`
- runtime lokalny: `runtime/llama-server.exe`

## Uruchomienie (dev)

```powershell
cd app
npm install
npm start
```

## Build EXE

```powershell
cd app
npm run dist
```

## Uwagi

- Zmiana aktywnego modelu restartuje lokalny serwer modelu.
- Aplikacja dziala lokalnie, wiec wydajnosc zalezy od CPU/GPU oraz ustawien runtime.
