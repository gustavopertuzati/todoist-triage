# Instructions pour l'agent OpenCode

## Carnet de notes de l'utilisateur

Avant de commencer une demande sur ce projet, lis **`data/assistant-notes.json`**
(s'il existe). C'est le carnet « Notes & idées » de l'application (bouton en bas à
droite).

Chaque note avec `"done": false` est une **demande supplémentaire** à traiter **en plus**
de la demande explicite de l'utilisateur :

1. Prends en compte **toutes** les notes en attente, pas seulement la dernière.
2. Implémente-les avec le reste de la demande.
3. À la fin, **liste précisément ce qui a été fait** (fichiers, tests, vérifications),
   note par note, pour que l'utilisateur puisse vérifier.
4. Marque comme faites (`"done": true`) les notes réellement implémentées. Pour éviter
   d'écraser l'état en mémoire du serveur, arrête le serveur local avant d'éditer le
   fichier, ou demande à l'utilisateur de cocher les notes dans l'interface.
5. Ne supprime jamais une note sans l'accord de l'utilisateur.

Le même contenu est disponible en Markdown via `GET /api/notes/export` et via le bouton
**« Copier pour OpenCode »** du carnet.

## Rappels projet

- Tests : `npm test` (node:test).
- Démarrage local : `node --env-file=.env server.js`.
- Ne jamais committer `.env` ni `data/`.
- Toute écriture Todoist passe par une proposition validée individuellement.
