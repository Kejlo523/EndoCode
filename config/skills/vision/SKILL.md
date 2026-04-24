# Vision (VLM Support)

Category: Zdolności Agenta
Local only: yes

## Summary
Włącza obsługę załączników obrazów na czacie oraz narzędzie analyze_image. Podczas instalacji pobiera lekki model VLM.

## Agent Instructions
Gdy używasz analyze_image lub wiesz, że użytkownik dostarczył obraz, polegasz na zewnętrznym asystencie wizji (Moondream2). Pamiętaj, aby opierać się na jego odczytach i przekazywać wnioski użytkownikowi wprost, ponieważ główny model działa bez obsługi obrazów.

## Local Runtime Rule
Use only local files, local model reasoning and approved local commands. Do not call cloud APIs unless the user explicitly adds such integration later.
