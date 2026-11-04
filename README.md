# Triage pour Todoist

Petite application web personnelle, pensée d'abord pour le téléphone, qui lit un compte
Todoist surchargé et aide à y voir clair.

> **Itération 1 — lecture seule.** Cette version ne modifie rien dans Todoist : elle
> affiche un résumé, explore les projets et permet de télécharger une sauvegarde JSON.
> Les dates écrites dans les titres (`JJ.MM.AAAA`, `auj`) sont détectées et affichées
> comme « à appliquer », mais aucune écriture n'est envoyée à Todoist.

## Ce que fait l'application

- Connexion par un mot de passe unique (cookie de session signé, `HttpOnly`).
- Lecture de **tous** les projets, sections, tâches actives, labels et du profil via un
  *full sync* officiel de l'API Todoist v1.
- Lecture des tâches terminées des 90 derniers jours (indicateur d'activité ; un échec de
  cet appel n'empêche pas l'export).
- Résumé : nombre de projets, tâches par projet, tâches en retard, projets vides,
  projets « sans progression », tâches sans échéance, tâches anciennes.
- Détection de la convention de date en **fin de titre** :
  - `11.10.2026` → échéance `2026-10-11` ;
  - `auj` / `auj.` → aujourd'hui, dans le fuseau configuré.
  Le titre affiché est nettoyé, et la date dérivée est marquée `needs_apply` (à appliquer
  plus tard, avec confirmation).
- Explorateur par projet, avec sections, sous-tâches et recherche.
- Téléchargement d'une sauvegarde JSON horodatée (`todoist-export-AAAA-MM-JJ-HHMM.json`)
  contenant les données brutes **et** les champs dérivés.
- Aucune donnée persistée côté serveur : l'export est généré à la demande et téléchargé
  par le navigateur. Un cache mémoire de 60 secondes évite de marteler l'API.

Les projets et tâches archivés sont présents dans l'export JSON mais exclus des compteurs
et de l'explorateur.

## Prérequis

- Node.js **22 ou plus** (testé avec Node 22).
- Un compte Todoist personnel.
- Un jeton API Todoist : *Paramètres → Intégrations → Développeur → Jeton API*.
  Les droits de lecture suffisent (`data:read`).

## Installation locale

```powershell
npm install
Copy-Item .env.example .env
# édite .env : TODOIST_API_TOKEN, APP_PASSWORD, SESSION_SECRET
node --env-file=.env server.js
```

L'application écoute sur <http://localhost:3000>. Sur mobile, depuis le même réseau Wi-Fi,
utilise l'adresse IP locale de la machine (`http://192.168.x.x:3000`).

Autre possibilité : définir les variables dans le terminal puis lancer `npm run dev`
(redémarrage automatique à chaque modification) :

```powershell
$env:TODOIST_API_TOKEN = "ton-jeton"
$env:APP_PASSWORD = "un-mot-de-passe-long"
$env:SESSION_SECRET = "une-chaine-aleatoire"
npm run dev
```

## Variables d'environnement

| Variable | Obligatoire | Défaut | Rôle |
| --- | --- | --- | --- |
| `TODOIST_API_TOKEN` | oui | — | Jeton API Todoist, utilisé uniquement côté serveur. |
| `APP_PASSWORD` | oui | — | Mot de passe d'accès à l'application (12 caractères minimum conseillés). |
| `SESSION_SECRET` | recommandé | dérivé de `APP_PASSWORD` | Clé HMAC qui signe le cookie de session. |
| `APP_TIMEZONE` | non | `Europe/Paris` | Fuseau pour « aujourd'hui » et l'horodatage des exports. |
| `PORT` | non | `3000` | Port d'écoute (Orkestr l'injecte automatiquement). |
| `SESSION_TTL_DAYS` | non | `30` | Durée de validité de la session. |
| `CACHE_TTL_SECONDS` | non | `60` | Durée du cache mémoire (`0` pour désactiver). |
| `COMPLETED_LOOKBACK_DAYS` | non | `90` | Fenêtre d'analyse des tâches terminées (max. 92). |
| `PROJECT_NO_PROGRESS_DAYS` | non | `30` | Âge minimum d'un projet « sans progression ». |
| `OLD_TASK_DAYS` | non | `180` | Seuil d'ancienneté d'une tâche. |
| `TODOIST_BASE_URL` | non | API officielle | Surcharge réservée aux tests locaux avec un faux Todoist. |

Toutes les valeurs sensibles sont lues uniquement depuis l'environnement du serveur.
Elles ne sont jamais envoyées au navigateur, journalisées ou incluses dans l'export.

Générer une clé de session :

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Tests

```powershell
npm test
```

Les tests unitaires couvrent l'analyse des dates de titre et la construction du résumé
(dont le filtrage des archives et les cas de date invalide).

## Déploiement sur Orkestr

Orkestr construit une image Docker à partir du dépôt. Le `Dockerfile` fourni est utilisé
tel quel ; l'application écoute sur `0.0.0.0:$PORT`.

1. **Pousser le code** sur GitHub, GitLab, Bitbucket ou Codeberg (le dépôt peut être privé).
2. Dans Orkestr, **Settings → Connected Providers** : connecter le fournisseur Git.
3. **Projects → New Project** : choisir le dépôt et la branche (`main`).
   Orkestr détecte Node/Express et le port. Le plan gratuit suffit (1 projet,
   1 environnement).
4. Ouvrir l'environnement **production**, puis **Environment Variables** et ajouter :
   - `TODOIST_API_TOKEN`
   - `APP_PASSWORD`
   - `SESSION_SECRET`
   - `APP_TIMEZONE` = `Europe/Paris`
   Ne pas définir `TODOIST_BASE_URL`.
5. Cliquer **Deploy** et suivre les logs jusqu'au statut **Live**.
6. L'application est disponible sur `https://<slug>.orkestr.run`.
   L'URL `/healthz` doit répondre `{"ok":true,...}`.

Toute modification d'une variable d'environnement nécessite un nouveau déploiement.

## Vérification sur téléphone (itération 1)

1. Ouvrir `https://<slug>.orkestr.run` : la page de connexion s'affiche.
2. Entrer un mauvais mot de passe : le message « Mot de passe incorrect. » apparaît.
3. Entrer le bon mot de passe : le tableau de bord « Ton Todoist, en clair. » s'affiche.
4. Vérifier que le nombre de projets et de tâches correspond à ton compte Todoist.
5. Ouvrir un projet dans **Explorer** : sections et sous-tâches apparaissent.
6. Chercher un mot connu dans la barre de recherche : les résultats se filtrent.
7. Repérer une tâche dont le titre finit par `JJ.MM.AAAA` ou `auj` : la date doit être
   affichée comme « à appliquer » et retirée du titre affiché.
8. Appuyer sur **Exporter** : un fichier `todoist-export-….json` est téléchargé.
9. Vérifier que **rien n'a changé dans l'application Todoist** (aucune date appliquée).
10. Se déconnecter : retour à la page de connexion ; l'URL `/` redirige vers `/login`.

## Structure

```
server.js              démarrage HTTP
src/app.js             routes Express, sécurité, gestion d'erreurs
src/auth.js            mot de passe + cookie de session signé
src/config.js          lecture des variables d'environnement
src/todoist.js         client API Todoist (retries, erreurs typées)
src/snapshot.js        normalisation, statistiques, dates dérivées
src/exportService.js   orchestration + cache mémoire
src/dates.js           analyse des conventions de date
views/                 pages HTML (connexion, tableau de bord)
public/                CSS et JavaScript navigateur
test/                  tests unitaires (node:test)
```

## Sécurité

- Mot de passe comparé à temps constant ; 10 tentatives max par IP et par tranche de
  15 minutes.
- Cookie `HttpOnly`, `SameSite=Lax`, `Secure` derrière HTTPS.
- Vérification d'origine et en-tête `X-App-Request: 1` sur les requêtes sensibles.
- En-têtes CSP stricts, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`.
- Aucune écriture Todoist dans cette itération ; aucun secret dans le dépôt.

## Périmètre

Itération 1 terminée : export et lecture seule. Les itérations suivantes (import avec
aperçu, questionnaire quotidien avec sélection assistée, analyse des projets jamais
terminés) ne sont pas implémentées et seront abordées après retour d'usage.
