# Bielik Minitron Local Sandbox

Ten folder zawiera lokalna konfiguracje modelu `speakleash/Bielik-Minitron-7B-v3.0-Instruct` w wersji GGUF Q5_K_M, uruchamiana przez `llama.cpp`.

## Start

GUI:

```powershell
.\app\dist\win-unpacked\"Local Codex.exe"
```

CLI:

```powershell
.\start-bielik.ps1
```

Domyslny sandbox to:

```text
.\workspace
```

Zeby dac agentowi inny katalog roboczy:

```powershell
.\start-bielik.ps1 -Workspace C:\sciezka\do\folderu
```

## Co jest ograniczone

- Narzedzia plikowe agenta rozwiazuja wszystkie sciezki pod wybranym sandbox root.
- Wyjscie poza sandbox przez `..`, sciezki absolutne albo skroty home jest odrzucane.
- Komendy PowerShell wymagaja potwierdzenia i maja dodatkowy filtr.
- To nie jest VM ani Docker. Jezeli potrzebujesz twardej izolacji systemowej, trzeba dolozyc Docker/Windows Sandbox osobno.

## Przydatne parametry

```powershell
.\start-bielik.ps1 -Port 8088 -Context 8192 -GpuLayers 99
.\start-bielik.ps1 -ServerOnly
```

Logi trafiaja do `.\logs`.

## Aplikacja GUI

Kod aplikacji jest w `.\app`. Interfejs pokazuje:

- rozmowe z modelem,
- wybor modelu z katalogu `.\config\models.json`,
- wybor intensywnosci pracy: szybko, normalnie, dokladnie, maksymalnie,
- jawne notatki/plany modelu,
- wywolania narzedzi,
- wyniki narzedzi,
- prosby o zatwierdzenie komend PowerShell,
- diffy po edycjach plikow.

Build:

```powershell
cd .\app
npm run dist
```

Gotowy plik:

```text
.\app\dist\win-unpacked\Local Codex.exe
```

## Zainstalowane modele

- `Qwen2.5-Coder 14B Q4_K_M` - domyslny, najlepszy balans na RTX 3060 12 GB.
- `Bielik Minitron 7B v3 Q5_K_M` - lekki lokalny model zapasowy.
- `Qwen3-Coder 30B-A3B Q4_K_M` - mocniejszy, wolniejszy, czesciowo CPU/RAM.
- `Qwen3.6 35B-A3B MXFP4` - najnowszy ciezszy Qwen MoE, dziala z reasoning wylaczonym po stronie `llama-server`.
- `DeepSeek-Coder V2 Lite Q4_K_M` - alternatywny lokalny coder.

`Claude Opus 4.5` nie ma lokalnych wag GGUF do pobrania. Mozna go podpiac tylko przez API, wiec w katalogu modeli jest zostawiony jako pozycja informacyjna.
