# Local Codex App

Desktopowy interfejs do lokalnych modeli kodujacych GGUF.

Modele sa definiowane w:

```text
C:\Users\Kejlo\Desktop\bielik\config\models.json
```

Wybor modelu i intensywnosci pracy jest dostepny w gornej belce aplikacji. Zmiana modelu resetuje kontekst rozmowy i restartuje lokalny `llama-server`.

Modele moga miec dodatkowe parametry startowe, np. `reasoning: "off"` dla modeli, ktore domyslnie oddaja pusta tresc w `content` i przenosza generacje do pola reasoning.

## Dev

```powershell
cd C:\Users\Kejlo\Desktop\bielik\app
npm install
npm start
```

## EXE

```powershell
npm run dist
```


Aplikacja szuka katalogu `models`, `runtime`, `workspace` i `config/model.json` w folderach nadrzednych.
