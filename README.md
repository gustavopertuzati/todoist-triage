# Triage pour Todoist

Petite application web personnelle, pensée d'abord pour le téléphone, qui lit un compte
Todoist surchargé et aide à y voir clair.

**En ligne :** <https://todoist-triage.orkestr.run> (instance configurée sur
`Europe/Zurich`). Code : <https://github.com/gustavopertuzati/todoist-triage>.

> **Itérations 1 à 37.** L'app affiche un résumé, explore les projets, **diagnostique chaque
> projet**, et te laisse **planifier jour par jour** : tu choisis un jour, réponds à un
> **check-in de 5 questions** (énergie, forme, temps, envie, humeur), et une **IA**
> (OpenRouter, `deepseek/deepseek-v4.1-flash`) propose les tâches les plus adaptées à ton
> état, en respectant une **charge 1-3-5** et en te proposant de **reporter** si nécessaire.
> Le **nettoyage guidé** repère les projets morts, doublons, tâches fantômes et orphelines,
> **avec corbeille réversible**, et un **retour sur les propositions ignorées** apprend à
> l'IA (ne plus reproposer, reporter, corriger la taille, reformuler). Une tâche peut aussi
> être **préparée** : l'IA propose des petites étapes datées avant (ou le jour même de) la
> tâche. Dans l'**explorateur**, tu ouvres une tâche pour voir **toutes ses sous-tâches**,
> en ajouter une à la main, et **découper** un dernier niveau en petits morceaux. Toutes les
> sous-tâches sont **numérotées dans l'ordre logique d'exécution** calculé par l'IA, à chaque
> niveau. Un bouton relance un **nettoyage de plus en plus profond**. Un **carnet de notes** en bas à droite
> garde tes idées d'amélioration pour la prochaine demande sur le projet. Tu **valides ou
> ignores chaque proposition individuellement**. Tant que tu n'as pas validé, **rien n'est
> écrit dans Todoist** ; chaque écriture validée est ensuite relue depuis l'API.
>
> La référence de date est l'**échéance native Todoist**. Les dates écrites dans les titres
> (`JJ.MM.AAAA`, `auj`) restent détectées et affichées passivement, mais ne sont pas la
> cible de travail retenue.

## Ce que fait l'application

- Connexion par un mot de passe unique (cookie de session signé, `HttpOnly`).
- Lecture de **tous** les projets, sections, tâches actives, labels et du profil via un
  *full sync* officiel de l'API Todoist v1.
- Lecture des tâches terminées des 90 derniers jours (indicateur d'activité ; un échec de
  cet appel n'empêche pas l'export).
- Résumé : nombre de projets, tâches par projet, tâches en retard, projets vides,
  projets « sans progression », tâches sans échéance, tâches anciennes.
- **Diagnostic des projets** : chaque projet actif reçoit un verdict (vide, sans
  progression, retards accumulés, beaucoup sans échéance, surchargé, aucune activité
  récente, ou sain), une liste de signaux chiffrés et une **proposition de nettoyage**.
  Les projets sont classés du plus préoccupant au plus sain, avec des filtres par type
  d'action. Voir « Itération 2 » ci-dessous.
- **Propositions validables une par une** : chaque carte se valide (ou s'ignore)
  individuellement, puis l'écriture est vérifiée via l'API. Voir « Itération 3 ».
- **Planification jour par jour assistée par une IA** : tu cliques un jour, réponds à un
  **check-in de 5 questions** (état/humeur), et l'IA propose les tâches adaptées à ton état
  (avec taille et justification), peut **reporter** ce qui dépasse et **scinder** une grosse
  tâche. Voir « Itérations 5 à 7 ».
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

## Itération 2 — diagnostic des projets

Chaque projet actif est analysé et reçoit un **verdict** unique (le signal le plus grave)
et une **proposition de nettoyage** :

| Verdict | Déclencheur | Proposition |
| --- | --- | --- |
| Projet vide | aucune tâche active (hors Inbox) | Archiver ou supprimer |
| Sans progression | tâches actives, 0 terminée sur la fenêtre, projet âgé | Réviser ou archiver |
| Retards accumulés | au moins 5 tâches en retard | Rattraper les retards |
| Beaucoup sans échéance | ≥ 10 tâches et ≥ 60 % sans échéance | Donner des échéances |
| Aucune activité récente | dernière activité il y a ≥ 60 jours | Décider du sort du projet |
| Projet surchargé | au moins 50 tâches actives | Découper et prioriser |
| Sain | aucun signal | Rien à faire |

Les seuils vivent dans `src/diagnosis.js` (`THRESHOLDS`) et sont volontairement simples.
Le diagnostic reste **indicatif** ; les modifications concrètes passent par les
propositions de l'itération 3.

## Itération 3 — propositions validées individuellement

L'app génère une liste d'actions concrètes et réversibles. Chaque carte propose une
modification précise, avec sa raison et son aperçu, et se **valide individuellement** :

| Type | Cible | Action appliquée |
| --- | --- | --- |
| Reporter | tâche en retard | échéance → aujourd'hui |
| Dater | tâche ancienne sans échéance | échéance → date proposée (modifiable) |
| Scinder | tâche dont la note contient une liste à puces | une sous-tâche par élément, note nettoyée |
| Archiver | projet vide ou sans progression (hors Inbox) | projet archivé (réversible) |

Garde-fous :

- Le serveur ne fait **aucune** écriture tant qu'une proposition n'est pas validée.
- Une proposition validée est **recalculée** sur un instantané frais : si elle n'est plus
  d'actualité (tâche modifiée entre-temps), l'application répond `409` et ne touche à rien.
- Après écriture, la ressource est **relue** via l'API pour confirmer l'effet (échéance,
  archivage, sous-tâches créées).
- Le bouton **Ignorer** masque durablement une proposition (stockage local du navigateur).
- `WRITES_ENABLED=false` coupe toutes les écritures côté serveur.

Détails d'implémentation : `src/proposals.js` (génération, pure et testée) et
`src/applyProposal.js` (exécution + vérification). Les écritures ne sont possibles que
pour une proposition présente dans l'instantané courant : aucune action arbitraire n'est
acceptée.

## Itérations 5 à 7 — planification par jour, charge 1-3-5 et check-in

Depuis l'itération 5, l'IA ne propose plus un lot global : on planifie **un jour à la fois**.

1. L'app calcule un **plan de charge** des 14 prochains jours à partir des échéances
   existantes, en estimant la taille de chaque tâche (durée renseignée, sinon nombre de
   sous-tâches et longueur de la note) : **Gros (L) / Moyen (M) / Petit (S)**.
2. Une journée saine respecte la règle **1-3-5** : au plus **1 grosse, 3 moyennes et
   5 petites** tâches. Une bande **« Charge par jour »** affiche, pour chaque jour, ce qui
   est déjà posé et ce qu'il reste.
3. Tu **cliques sur un jour**. L'app t'indique la **place restante** et demande à l'IA
   quelles tâches conviennent le mieux à **cette journée précise**, sans dépasser la place.
4. Tu valides ou ignores chaque carte, puis tu passes à un autre jour. Valider une carte
   n'affecte **pas** les autres : la place du jour est simplement recalculée.
5. L'IA peut aussi proposer de **scinder** une grosse tâche en 2 à 10 sous-tâches.

### Sous-tâches

- un **parent qui a des sous-tâches** est un conteneur : il n'est **jamais** proposé
  directement, ni **jamais scindé** (on ne recrée pas des sous-tâches à l'infini) ;
- ce sont ses **sous-tâches** (tâches « feuilles ») qui sont analysées, triées et planifiées ;
- le parent daté affiche son nombre de sous-tâches dans « Déjà prévu ce jour ».

### Check-in du jour (itération 7)

Avant de planifier, tu peux répondre à **5 questions rapides** : énergie, forme, temps
disponible, envie, humeur. Par exemple, si tu te sens **malade et épuisé** :

- la **charge autorisée** de la journée est fortement réduite (ex. « 0 gros · 0 moyens ·
  3 petits », plafonnée par le temps disponible) ;
- l'IA ne propose alors **que des tâches légères**, et surtout **de proposer de reporter**
  les tâches déjà prévues ce jour vers des jours qui ont de la place ;
- l'interface affiche l'**objectif du jour**, les consignes liées à ton état et un
  avertissement si la journée dépasse encore cette charge.

Le check-in est **mémorisé par jour** dans ton navigateur ; tu peux le modifier à tout
moment et cliquer **« Adapter ma journée »** pour re-planifier.

Chaque jour a son propre cache (empreinte des données **et du check-in**) : revenir sur un
jour ne rappelle pas le modèle. Les cartes déjà affichées restent validables même après une
écriture (magasin en mémoire 2 h), donc plus de « cette proposition n'est plus
d'actualité » parce qu'une autre a été validée.

Le modèle répond uniquement par un JSON :

```json
{
  "summary": "Journée allégée : repos, peu de tâches, et reports à droite.",
  "proposals": [
    { "task_id": "…", "due_date": "2026-11-05", "size": "S", "reason": "…", "group": "Admin" }
  ],
  "defer": [
    { "task_id": "…", "due_date": "2026-11-09", "reason": "à reporter, journée trop chargée" }
  ],
  "splits": [
    { "task_id": "…", "reason": "…", "subtasks": ["…", "…"] }
  ]
}
```

Garde-fous : l'IA ne peut produire que des échéances (`set_due_date`, bornées au jour choisi
pour les ajouts, à la charge autorisée) et des reports (`defer`, bornés à la place des jours
cibles), plus des scissions (`split_task`). Tout dépassement ou cible inconnue est
**écarté** côté serveur. Aucune donnée sensible n'est envoyée (titres, métadonnées, date,
réponses au check-in). Sans clé (`AI_ENABLED=false`), l'app fonctionne en mode règles.

Le panneau **« Autres propositions »** regroupe les actions non liées à une date : archiver
un projet vide ou dormant, scinder une tâche dont la note est une liste, reporter un retard.

Seuils configurables : `CAPACITY_HORIZON_DAYS`, `CAPACITY_MAX_LARGE`,
`CAPACITY_MAX_MEDIUM`, `CAPACITY_MAX_SMALL`, `AI_ALLOW_SPLITS`, `AI_MAX_TOKENS`,
`AI_REASONING_MAX_TOKENS` (plafond de réflexion du modèle), `AI_CACHE_TTL_MINUTES`.

Les propositions IA **remplacent** l'ancienne règle « datation en vrac » (qui mettait tout
à la même date) : la datation par règles est désactivée dès que l'IA est active.

## Itération 8 — nettoyage guidé

Le panneau **« Nettoyage guidé »** recense les tâches à écarter, de la plus à la moins
importante. Quatre catégories sont détectées :

| Catégorie | Déclencheur | Action proposée |
| --- | --- | --- |
| Projets morts | projet sans tâche active ou sans progression sur 90 j (hors Inbox) | Archiver (réversible) |
| Doublons | titres quasi identiques (accents/casse/URL ignorés) dans un même projet | Supprimer le doublon le moins riche |
| Tâches fantômes | tâche très ancienne (≥ 365 j), sans échéance, jamais modifiée | Supprimer (abandonner) |
| Tâches orphelines | tâche dont le projet n'existe plus | Supprimer |

Garde-fous de la suppression :

- Chaque suppression part vers Todoist **uniquement après validation** individuelle.
- La tâche est d'abord placée en **corbeille** (mémoire serveur, 24 h) : tu peux la
  **restaurer à l'identique** à tout moment depuis l'interface (bouton **« Annuler
  (restaurer) »**).
- La **relecture** confirme que la tâche a bien disparu.
- Les seuils sont configurables : `CLEANUP_GHOST_DAYS` (365), `CLEANUP_MAX_PER_KIND` (10),
  `CLEANUP_MAX_TOTAL` (25). La détection se désactive avec `CLEANUP_ENABLED=false`.

Implémentation : `src/proposals.js` (`buildCleanupTasks`) pour la détection et
`src/recycleBin.js` pour la corbeille. La détection de doublons est pure et testée.

## Itération 9 — confort d'usage

Trois ajouts pour un usage plus agréable, notamment sur mobile.

### Tout valider
Dans un plan du jour, un bouton **« Tout valider (n) »** applique d'un coup toutes les
propositions en attente de ce jour (ajouts, reports, scissions). Chacune passe par le même
garde-fou que d'habitude (validation + relecture + corbeille si suppression) ; si l'une
expire, l'application s'arrête et recharge proprement.

### Analyse à la demande
L'IA ne se déclenche **que** quand tu appuies sur **« Analyser »** (ou « Adapter ma
journée » / « Nouvelles propositions »). À l'ouverture ou au **rechargement de la page**,
l'app se contente d'afficher l'état du jour et, s'ils existent déjà, les propositions mises
en cache — elle n'en **crée pas de nouvelles** toute seule. Le cache est validé par
empreinte des données **et du check-in** : il reste valable tant que rien n'a changé
(`AI_CACHE_TTL_MINUTES`, défaut 30 min).

### PWA / appli installable
L'app est une **PWA** : sur ton téléphone, « Ajouter à l'écran d'accueil » l'installe comme
une vraie app en plein écran. Un service worker met en cache le « shell » (pages, CSS, JS)
pour un démarrage rapide et une disponibilité hors-ligne limitée ; les données Todoist et
la session ne sont **jamais** mises en cache.

- `public/manifest.webmanifest` (nom, icônes, affichage standalone)
- `public/icon-192.png`, `public/icon-512.png`, `public/apple-touch-icon.png`
- `public/sw.js` (service worker)
- Balises `<meta name="mobile-web-app-capable">`, `apple-mobile-web-app-capable`, icône
  Apple, manifest.

### Récap de la semaine
Sous le planificateur, un **récap** de la semaine courante : nombre de journées, tâches
planifiées, jours libres / complets, et le jour le plus chargé — avec un conseil si la
semaine est dense.

Seuil : aucun (calculé à partir de la charge). Aucune donnée persistée de plus côté serveur.

## Itération 10 — retour sur les propositions ignorées

Quand tu ignores une proposition, un **mini-questionnaire** recueille la raison pour que
l'IA s'améliore réellement (au lieu de reproposer la même chose).

Raccourcis en un tap : **« Plus tard »** et **« Jamais »**. Sinon **« Autre raison… »**
ouvre un questionnaire ciblé et conditionnel :

| Question | Valeurs | Effet |
| --- | --- | --- |
| Pourquoi ? | pas maintenant · pas le bon jour · trop gros · pas prioritaire · titre pas clair · déjà fait · ne plus proposer | signal principal |
| Quand ? | demain · cette semaine · semaine prochaine · ce week-end · jamais | report (ne pas proposer avant) |
| Sa taille ? | petit / moyen / gros | corrige l'estimation |
| Valable | juste cette fois · toujours pour cette tâche | étend ou limite |

Mais surtout, **le questionnaire s'adapte au type de proposition** :

| Proposition ignorée | Questions | Effet |
| --- | --- | --- |
| **Reporter** (déplacer hors du jour) | Pourquoi la **garder aujourd'hui** ? · Comment l'**adapter** ? | la tâche reste ce jour, l'IA propose une **adaptation** (découper, version courte…) — ou « ça peut attendre » → report |
| **Découper** | Pourquoi pas de découpage ? · Que faire à la place ? | on ne repropose plus de découpe, ou on reformule/abandonne |
| **Reformuler** | Le titre te convient ? | on ne repropose plus de titre |
| **Nettoyage** (archiver/supprimer) | Pourquoi la garder ? | on ne repropose plus ce nettoyage |

Exemple : si l'IA propose de **reporter** « Séance C », le questionnaire demande « Pourquoi
la garder aujourd'hui ? » (date limite, quelqu'un l'attend, c'est rapide, important). Si tu
réponds « J'y tiens aujourd'hui », l'app **relance l'analyse** : l'IA **garde la tâche**
ce jour-là (adaptée si besoin) et **reporte autre chose** à la place.

Ce que l'app en fait :

- **Plus jamais reproposée** : une tâche marquée « ne plus proposer » / « jamais » / « tâche
  inutile » est **exclue** des analyses suivantes, côté client **et** côté serveur.
- **Report** : « pas avant une date » — la tâche n'est pas proposée d'ici là.
- **Correction de taille** : ta taille réelle prime sur l'estimation.
- **Amélioration de la tâche** : « titre pas clair » ou « trop gros » → l'IA peut
  **reformuler le titre** (`rename_task`) ou **scinder** la tâche.
- **Adaptation** : « je la garde aujourd'hui » → pas de report ; l'IA propose comment
  l'adapter (découper, version courte, garder et reporter autre chose).
- **Jamais découper / reformuler / nettoyer** : signalés et respectés.
- Les signaux agrégés (comptes par raison) sont envoyés au modèle pour qu'il **généralise**.

Les réponses sont **mémorisées sur ton appareil** (localStorage) et transmises à chaque
analyse. Implémentation : `src/feedback.js` (pur et testé) + `src/aiProposals.js`.

## Itération 12 — préparer une tâche

Une grosse tâche (« Ranger la cave ») est souvent repoussée parce qu'elle paraît
infaisable d'un bloc. Depuis l'explorateur, le bouton **« ✨ Préparer »** demande à l'IA
des **tâches de préparation** courtes et concrètes :

- « Sortir les cartons à descendre »
- « Faire la liste de ce qu'il faut trier »
- « Préparer les sacs et la lampe »

L'IA **réfléchit** et place chaque préparation **avant** la tâche (ou **le jour même** si
elle est aujourd'hui), en respectant la place restante des jours (règle 1-3-5). Chaque
préparation devient une **sous-tâche datée** du parent — jamais créée sans validation.

Ce que fait le moteur :

- filtre les doublons avec les sous-tâches existantes et les titres trop courts ;
- refuse une date hors de la fenêtre *aujourd'hui → échéance de la tâche* ;
- **ne bloque plus sur la capacité 1-3-5** : une préparation est une petite action de
  mise en route, elle peut se poser même si la journée est pleine ;
- **numérote les préparations** (`1.`, `2.`, `3.`) et les crée **toujours en sous-tâches**
  de la tâche parente ;
- plafonne le nombre de préparations (`PREP_MAX_ITEMS`, 3 par défaut) ;
- ne propose rien pour une tâche qui a déjà des sous-tâches ;
- répond **« trop tôt »** pour une tâche dont l'échéance dépasse 30 jours : la
  préparation sera proposée dans le mois qui précède, pas neuf mois à l'avance.

Routes : `POST /api/prepare` (génération), puis la validation habituelle
`POST /api/proposals/:id/apply` (création des sous-tâches, relue via l'API).
Implémentation : `src/prepare.js` (pur et testé) + `src/applyProposal.js`.

## Itération 13 — explorer les sous-tâches, découper, nettoyer plus profond

### Le widget suit le jour choisi

Quand tu cliques un jour dans la bande de charge, la partie « Le widget » affiche
immédiatement **les tâches prévues ce jour-là** (et non plus seulement aujourd'hui).
Le titre, le compteur et la liste changent avec le jour sélectionné ; les retards restent
visibles dans un bloc séparé quand le jour choisi est aujourd'hui.

Chaque tâche de cette liste a les **mêmes actions que dans l'explorateur** :

- **« 🗂 Voir »** ouvre le détail avec toutes les sous-tâches (et permet d'en ajouter) ;
- au dernier niveau, **« ✨ Préparer »** propose les petites étapes datées ;
- le détail permet aussi de **découper** une tâche feuille.

### Explorer une tâche à tous les niveaux

Dans **Explorer**, chaque tâche a un bouton **« 🗂 Voir »** qui ouvre son détail :

- l'arbre complet des **sous-tâches, sous-sous-tâches, etc.** (cliquables pour descendre
  d'un niveau) ;
- un champ **« Ajouter une sous-tâche »** (écriture explicite, relue via l'API) ;
- au **dernier niveau** (aucune sous-tâche), un bouton **« ✂️ Découper en petits
  morceaux »** : l'IA propose 2 à 5 sous-tâches concrètes, validées une fois puis créées.

Routes : `POST /api/tasks/:id/subtasks` (ajout manuel) et
`POST /api/tasks/:id/decompose` (découpage IA, sans écriture avant validation).
Réglage : `DECOMPOSE_MAX_ITEMS` (5 par défaut).

### Nettoyage de plus en plus profond

Le panneau **Nettoyage guidé** a un bouton **« 🔎 Lancer un nettoyage approfondi »**.
Chaque clic relit Todoist et élargit la recherche (niveaux 1 à 4) :

| Niveau | Fantômes | Portée |
| --- | --- | --- |
| 1 | ≥ 245 j | plafonds élargis |
| 2 | ≥ 125 j | **sous-tâches incluses** |
| 3 | ≥ 30 j | **doublons entre projets** |
| 4 | ≥ 30 j | plafonds maximaux |

Un résumé indique le niveau, le seuil de fantômes, le nombre de tâches inspectées et les
extensions actives. Aucune suppression n'est automatique : ce sont toujours des
propositions à valider.

### Espacements

Les sections du tableau de bord sont maintenant dans un **conteneur flex avec une vraie
gouttière** (`#content`, 22 px) : les panneaux ne se touchent plus, ni sur mobile ni sur
desktop. Les KPI ont 16 px entre eux, les propositions/diagnostics 14 px, les projets
12 px, et chaque bloc du widget a son propre fond arrondi avec padding. Sur petit écran,
la page et les panneaux respirent davantage, les boutons de proposition passent à la ligne
et les formulaires s'empilent.

## Itération 14 — ordre logique des sous-tâches

Quand tu ouvres une tâche (**🗂 Voir**, depuis Explorer ou depuis le widget du jour),
l'app envoie à l'IA **tout l'arbre** de ses sous-tâches (sous-tâches, sous-sous-tâches,
etc.). L'IA ordonne les enfants de **chaque niveau** dans l'ordre d'accomplissement :
prérequis, exécution, puis vérification/clôture.

- Chaque sous-tâche affiche un **numéro** (`1.`, `2.`, `3.`…) à son niveau ;
- un résumé explique l'ordre choisi ;
- le bouton **« 🧠 Réordonner »** relance l'analyse ;
- l'IA ne renomme rien, ne supprime rien et n'écrit rien dans Todoist : elle ne renvoie
  qu'un ordre d'affichage (cache 30 min).

Route : `POST /api/tasks/:id/order` — implémentation `src/subtaskOrder.js`.

### Préparations et widget

- Les préparations créées sont **toujours des sous-tâches** du parent, **numérotées**
  dans l'ordre d'exécution (`1. …`, `2. …`, `3. …`).
- Le **widget du jour n'affiche que les tâches principales** : les préparations et autres
  sous-tâches ne le polluent plus. Elles restent visibles via **🗂 Voir** sur la tâche
  parente (avec leur numéro et leur ordre).

## Itération 15 — renumérotation, notes éditables, découpage sélectif, contexte

### Les numéros se recollent après une suppression

- Quand une sous-tâche **numérotée** est supprimée via l'app, les frères et sœurs encore
  présents sont **renumérotés** (`1.`, `2.`, `3.`…) dans l'ordre courant.
- L'ajout manuel d'une sous-tâche dans un groupe numéroté reçoit le **numéro suivant**,
  puis tout est recalé.
- Un bouton **« 🔄 Renuméroter »** dans le détail permet de recoller les numéros après une
  suppression faite directement dans Todoist.
- Les titres affichés retirent l'ancien préfixe : le numéro visible est toujours le numéro
  dynamique d'exécution, jamais un « 1. 3. … ».
- Route : `POST /api/tasks/:id/renumber` — logique pure dans `src/renumber.js`.

### Carnet : modifier une note

Chaque note du carnet a maintenant un bouton **« ✎ »** : on peut changer son **texte** et
son **type** (amélioration, bug, note, idée), puis enregistrer. La suppression et l'ajout
restent disponibles.

### Découpage : ignorer des morceaux

Sur une proposition de **découpage** (`split_task`), chaque morceau a une **case à cocher**.
Décoche ce que tu ne veux pas créer : seuls les morceaux cochés deviennent des
sous-tâches. Le serveur applique la sélection envoyée (`subtasks`), et refuse une
sélection vide.

### Check-in : contexte et filtres Todoist

- Nouvelle question **« Contexte »** à choix multiples : **ordinateur**, **téléphone /
  appels**, **maison**, **extérieur / courses**, **bureau**, **peu importe**.
- L'IA reçoit ces choix et évite les tâches qui exigent un contexte absent (pas
  d'ordinateur, pas d'appels, pas de sorties).
- Les **filtres sauvegardés Todoist** sont désormais lus (`filters` dans le full sync),
  affichés dans le check-in et transmis à l'IA comme indices de contextes.
- Réglages inchangés : les questions énergie / forme / temps / envie / humeur continuent
  de moduler la charge 1-3-5.

## Itération 16 — découpage contextualisé, préparations dans le widget, sélection

### Un découpage qui comprend le contexte

Le découpage assisté reçoit maintenant **toute la hiérarchie** :

- tâche racine, parent direct, chemin complet, niveau courant ;
- projet, labels, note, échéance, sous-tâches existantes et tâches sœurs.

L’IA doit d’abord expliquer **ce qu’elle comprend**, puis proposer des morceaux :

- concrets : un verbe + un objet précis + un résultat vérifiable ;
- adaptés au niveau : phases de 20-60 min au niveau 1, gestes précis aux niveaux
  profonds ;
- sans micro-découpage artificiel (pas une sous-tâche par série/répétition) ;
- sans morceau vague du type « s’organiser » ou « préparer ».

Le résumé de la proposition commence par « Ce que je comprends : … ».

### Les préparations apparaissent dans le widget du jour

- Les préparations créées sont marquées dans leur description
  (`Préparation créée par Triage`).
- Le **widget du jour** affiche donc les préparations prévues ce jour-là, avec un badge
  **🧩 Préparation de « tâche parente »**.
- On peut les **voir**, les **préparer à leur tour** ou les **découper** depuis le détail.
- Les autres sous-tâches (découpes classiques) restent masquées du widget.

### Choisir les préparations à créer

Dans la fenêtre « Préparer la tâche », chaque préparation a une **case à cocher** :

- décoche ce qui est **déjà fait** ou inutile ;
- les **dates des préparations conservées se recalent** automatiquement sur les dates
  disponibles, dans l’ordre ;
- l’aperçu et le compteur se mettent à jour ;
- le serveur ne crée que la sélection envoyée (`preparations`), refuse une sélection vide
  et renumérote les préparations créées.

## Itération 17 — réorganiser la journée

Dans le widget du jour, un bouton **« 🔀 Réorganiser la journée »** produit deux ordres :

- **Priorité** : P1 → P4, retards d'abord, puis ordre alphabétique ;
- **Exécution** : proposé par l'IA en tenant compte des dépendances, des préparations
  (avant leur tâche parente), des retards, des priorités et de l'alternance
  grosses/petites tâches.

L'ordre s'affiche avec des **numéros**, la priorité, la taille, les retards, le parent des
préparations et une **raison courte** par tâche en mode exécution. Un sélecteur
**Priorité / Exécution** permet de basculer. La liste inclut les tâches principales, les
**préparations du jour** et, si le jour choisi est aujourd'hui, les retards.

Aucun ordre n'est écrit dans Todoist : c'est une aide à l'exécution, en lecture seule.
Route : `POST /api/day/order` — implémentation `src/dayOrder.js` (cache 30 min).

Le clic affiche **immédiatement** un ordre de priorité local (prévisualisation), puis l'IA
affine l'ordre d'exécution. Si l'IA est indisponible ou dépasse le délai, l'ordre de
priorité reste affiché avec une explication — le bouton ne reste jamais bloqué.

## Itération 18 — planifications horaires et rappels Todoist natifs

### Durées et contextes

Pour chaque tâche du jour, l'IA estime maintenant :

- une **durée réaliste en minutes** (5 à 480), à partir du titre, de la note, de la taille
  et du contexte ; la durée native Todoist reste prioritaire si elle existe ;
- un **contexte** : `phone`, `computer`, `home`, `outside`, `office`, `other`.

Les tâches « téléphone » (titre ou label contenant appel, téléphone, SMS, WhatsApp…) sont
planifiées à partir de **09:00**. Les autres commencent à **11:00** au plus tôt, et jamais
avant la fin réelle des tâches téléphone, pour éviter les chevauchements. La journée se
termine à **17:00** ; un dépassement est signalé.

### Quatre planifications proposées

Le bouton **« 🔀 Réorganiser la journée »** affiche les tâches par heure et propose :

- **Exécution** : ordre logique de l'IA ;
- **Priorité** : P1 → P4 ;
- **Courtes d'abord** : tâches les plus courtes en premier ;
- **Départ décalé** : même ordre, téléphone à 10:00 et reste à 11:30.

Chaque tâche affiche son créneau (`09:00–09:30`), sa durée et un éventuel dépassement
après 17h.

### Rappels Todoist natifs

Le bouton **« 🔔 Activer les rappels »** crée **un rappel absolu Todoist par tâche**, à
l'heure de début du créneau choisi. On garde ainsi les notifications natives de l'app
Todoist, sans infrastructure push.

- Le mapping `tâche → rappel` est conservé dans le navigateur (`localStorage`).
- Les rappels identiques sont **réutilisés** (pas de doublons).
- Une modification de la journée (ajout, suppression, réorganisation, validation) déclenche
  un **recalcul silencieux** : les rappels obsolètes sont supprimés et les nouveaux créés.
- **« Désactiver »** retire les rappels de la journée.
- Si le `localStorage` est vidé, des rappels orphelins peuvent rester : il suffit de les
  supprimer dans Todoist.

Route : `POST /api/day/reminders` — implémentation `src/reminders.js` (Sync API Todoist)
et `src/dayOrder.js` (durées, plans).

## Itération 19 — horaires personnalisables

Avant de réorganiser la journée, trois horaires sont modifiables dans le widget :

- **Début téléphone** (09:00 par défaut) ;
- **Début autres tâches** (11:00 par défaut) ;
- **Fin de journée** (17:00 par défaut).

Ils sont mémorisés dans le navigateur (`localStorage`) et utilisés pour :

- les quatre planifications (Exécution, Priorité, Courtes d'abord, Départ décalé) ;
- les créneaux affichés (`10:00–10:45`, etc.) ;
- les rappels Todoist natifs.

Modifier un horaire relance automatiquement le calcul de l'ordre et des créneaux. Les
rappels déjà actifs gardent leurs anciens horaires jusqu'à **« Mettre à jour les
rappels »** ; un clic applique alors les nouveaux horaires.

Le serveur valide/normalise les valeurs (`HH:MM`), garantit `début < fin` et empêche les
chevauchements entre tâches téléphone et autres tâches.

## Itération 20 — pauses entre les tâches et pause déjeuner

Le planning n'enchaîne plus les tâches comme un robot :

- **Pause entre les tâches** : 10 min par défaut, réglable de 0 à 120 min.
- **Pause déjeuner** : 12:00–13:00 par défaut, début et fin modifiables.

Règles de calcul :

- après chaque tâche, le curseur avance de la pause ;
- une tâche qui commencerait pendant le déjeuner, ou qui le chevaucherait, est décalée
  après la pause déjeuner ;
- les pauses sont comptées dans la journée : elles peuvent créer un dépassement après
  l'heure de fin, signalé dans l'interface.

Les horaires et pauses restent mémorisés dans le navigateur et s'appliquent aux quatre
planifications ainsi qu'aux rappels Todoist natifs.

## Itération 21 — plan figé, notes redimensionnables, contexte de vie

### Le plan de journée reste figé

Une fois la journée réorganisée, le plan est **enregistré dans le navigateur** (date par
date) :

- il reste affiché après un rechargement ou en revenant sur le jour ;
- la variante choisie (Exécution, Priorité, Courtes, Décalé) est conservée ;
- les horaires affichés ne changent plus automatiquement quand une tâche est ajoutée ou
  quand les réglages d'horaires sont modifiés ;
- seul un clic sur **« 🔀 Réorganiser » / « ↻ Recalculer l'ordre »** recalcule le plan ;
- si des rappels sont actifs, ils sont recalés **uniquement après ce clic**.

Les réglages d'horaires restent modifiables sans casser le plan affiché : le prochain
recalcul les applique.

### Zone de notes redimensionnable

Les zones de texte du carnet (ajout et édition) ont une poignée native en bas à droite
(`resize: both`) : on peut les agrandir ou les réduire horizontalement et verticalement.

### Contexte de vie pour l'agent

`LIFE_CONTEXT.md` contient les projets en cours, leur avancement et leurs blocages
(OpenCode, JobOps, n8n, AWS, calories, sport, permis, plantes, puzzle), ainsi que les
règles de prudence (pas de WhatsApp/mail, pas de contrôle du téléphone sans demande).

`AGENTS.md` demande à l'agent de lire ce fichier avant toute priorisation. Le fichier reste
privé et n'est pas exposé par l'application.

## Itération 22 — projets, ignore sans rechargement, ordre manuel

### Des propositions ancrées dans les projets et les échéances

Le digest envoyé à l'IA contient maintenant :

- `project_context` : nom, verdict, score, nombre de tâches, retards, tâches sans date,
  activité récente et description de chaque projet ;
- `due_soon` : les tâches qui arrivent dans les 14 jours ;
- les tâches candidates incluent aussi celles dues prochainement, avec `due_in_days`.

Consignes imposées à l'IA :

- une tâche due aujourd'hui ou en retard est prioritaire ;
- une tâche due plus tard n'est pas sortie de son échéance sans raison ;
- elle peut être proposée en avance seulement si c'est une petite préparation utile, si
  elle débloque un projet, ou si la journée a vraiment de la place ;
- une tâche qui débloque un projet dormant/en retard passe avant.

### Ignorer sans recharger

- Ignorer une proposition **retire seulement la carte** : plus de rechargement complet ni
  de nouvelle analyse.
- Les tâches **ignorées** et **acceptées** sont mémorisées par date dans le navigateur.
- Une tâche déjà acceptée ou ignorée n'est plus reproposée pour ce jour, même après une
  nouvelle analyse ou un rechargement.

### Réorganiser à la main

- Chaque ligne de l'ordre du jour a des boutons **▲ / ▼**.
- Le déplacement recalcule **immédiatement** les horaires de toutes les tâches, avec les
  pauses et la pause déjeuner.
- L'ordre manuel est sauvegardé avec le plan et reste après rechargement.
- Si des rappels sont actifs, ils sont mis à jour après le déplacement (léger debounce),
  en utilisant exactement les créneaux affichés.

## Itération 23 — nouvelles tâches suggérées et plan recalculé après report

### Suggérer de nouvelles tâches

Dans le panneau de planification, un bouton **« 💡 Suggérer de nouvelles tâches »**
demande à l'IA 1 à 3 tâches **à créer** pour la journée, en tenant compte :

- des projets et de leur état (`project_context`) ;
- des échéances proches (`due_soon`) ;
- de la charge restante (`can_add`) ;
- du check-in et du contexte.

Chaque suggestion est une proposition `create_task` :

- titre concret, projet existant, échéance du jour, priorité et taille ;
- aucun doublon avec une tâche existante ;
- aucune écriture avant validation ;
- à la validation, la tâche est créée dans Todoist et relue.

`AI_MAX_NEW_TASKS` (5 par défaut) limite le nombre de suggestions.

### Le plan se recale après un report

Quand une proposition **Reporter** (ou une suppression) est validée :

- la tâche est retirée du plan de journée figé ;
- les horaires de toutes les tâches restantes sont recalculés immédiatement, en
  supprimant le trou et en gardant pauses/déjeuner ;
- le plan sauvegardé est mis à jour ;
- les rappels actifs sont resynchronisés avec les nouveaux créneaux.

## Itération 24 — suggestions ancrées dans LIFE_CONTEXT.md et journal de progression

### Les suggestions lisent le contexte de vie

Le digest des suggestions contient maintenant **`life_context`**, lu depuis
`LIFE_CONTEXT.md`. L'IA doit :

- cibler un projet/objectif réel du fichier ;
- remplir `life_area` avec le nom exact de cet objectif ;
- proposer **plusieurs** tâches (jusqu'à 5 par défaut) ;
- répartir les dates entre **aujourd'hui** et **les 30 prochains jours** selon
  l'avancement et les blocages ;
- éviter les tâches de communication non demandées.

Vérifié : suggestions générées pour OpenCode, JobOps, n8n, AWS et le permis, avec
`life_area` correspondant et un jalon futur.

### Progression enregistrée dans le fichier des objectifs

Quand une tâche issue d'une suggestion est créée, une ligne est ajoutée dans
`LIFE_CONTEXT.md`, section **« Journal des tâches créées »** :

```md
- [ ] **Étudier AWS Developer Associate** — Ouvrir le cours et regarder 10 min sur IAM
  (échéance 2026-11-05) · créée 2026-11-05 · id <taskId>
```

- l'ajout est **idempotent** par identifiant Todoist ;
- les 200 dernières lignes sont conservées ;
- le fichier reste lisible par l'agent pour la suite.

**Limite :** en local, le fichier est persistant. Sur Orkestr, le système de fichiers
du conteneur est éphémère : la progression peut être perdue à un redéploiement. Le
fichier local reste la référence pour l'agent.

## Itération 25 — suggestions multiples et ajout en bas du plan

### Plusieurs suggestions, sans doublons

- Le générateur fait maintenant jusqu'à **deux passes** : si l'IA ne rend qu'une ou deux
  idées, elle est relancée en excluant celles déjà proposées.
- Le client envoie la liste des titres **déjà suggérés/acceptés** (`exclude`) : les
  relances proposent donc de nouvelles tâches au lieu de répéter les mêmes.
- Les suggestions restent variées (iTheorie, calories, sport, n8n, AWS, JobOps, plantes…)
  et peuvent viser aujourd'hui ou les 30 prochains jours.

### Ajout automatique en bas du plan

Quand une proposition **place** une tâche sur le jour sélectionné (ou crée une nouvelle
tâche pour ce jour) :

- si la journée a déjà un **plan organisé**, la tâche est ajoutée **en bas** de la liste ;
- tous les horaires sont recalculés (pauses/déjeuner inclus) et le plan est sauvegardé ;
- les rappels actifs sont resynchronisés ;
- si la journée n'a pas encore été organisée, aucun plan n'est créé : la tâche reste
  simplement dans Todoist.

## Itération 26 — horaires dans les titres et remplacement des rappels

> **Mise à jour itération 28 :** l’heure n’est plus écrite dans le titre mais dans
> l’échéance de la tâche. Voir la section 28.

### Horaires inscrits dans les titres Todoist

Quand tu réorganises une journée (ou déplaces une tâche dans le plan), les horaires sont
écrits dans le titre de la tâche Todoist :

```text
1. Trier les cartons · 09:00–09:30
```

- format stable en **suffixe** ;
- un ancien suffixe est retiré avant d'écrire le nouveau (pas de doublons) ;
- fonctionne aussi après plusieurs réorganisations ;
- route : `POST /api/day/times` ;
- les titres sont mis à jour après « Réorganiser », un déplacement ▲/▼, un ajout ou un
  report dans le plan.

### Anciens rappels supprimés

Lors d'une activation/mise à jour des rappels :

- **tous les rappels absolus** des tâches replanifiées sont supprimés ;
- les rappels connus de tâches sorties du plan sont aussi supprimés ;
- de nouveaux rappels sont créés aux créneaux du plan.

Cela évite les doublons et les anciens horaires. Attention : un rappel absolu personnel
sur une tâche replanifiée sera aussi remplacé.

## Itération 27 — récurrences, anti-doublon du jour, début à l’heure actuelle

### Récurrences peu accomplies

Le nettoyage guidé détecte les tâches **récurrentes** qui sont :

- assez anciennes (`CLEANUP_RECURRING_MIN_AGE_DAYS`, 30 j par défaut) ;
- terminées très peu de fois sur la période
  (`CLEANUP_RECURRING_MAX_COMPLETIONS`, 2 par défaut) ;
- sans sous-tâches.

Pour chacune, deux propositions sont faites :

- **Supprimer** la récurrence (corbeille réversible) ;
- **Renommer** avec un titre plus court, pour alléger la charge mentale.

### Pas de tâche déjà faite aujourd’hui

Les tâches terminées dans la journée sont maintenant exposées (`completed.today`) et
injectées dans le digest des suggestions. L’IA et la validation les excluent, même si elle
reformule le titre. Fini les « 3 repas Lose It » reproposés après les avoir déjà faits.

### Début ajusté à l’heure actuelle

Au premier chargement du jour, les heures de début (téléphone et autres tâches) sont
avancées à **l’heure actuelle arrondie aux 5 minutes suivantes**, sans dépasser l’heure de
fin. Les anciennes valeurs futures sont conservées. Le plan déjà organisé reste figé ;
un clic sur « Réorganiser » applique les nouveaux horaires.

### Notes de contexte

`LIFE_CONTEXT.md` contient désormais :

- le lien du projet **JobOps** : <https://github.com/DaKheera47/job-ops> ;
- le détail des workflows **n8n** (courrier fiduciaire, alertes d’erreurs, webhooks
  WhatsApp Meta).

## Itération 28 — heures dans l’échéance, plus dans le titre

L’heure de début n’est plus un texte dans le titre. Lors d’une réorganisation :

- les anciens suffixes horaires sont **retirés du titre** ;
- la tâche reçoit une **échéance avec heure** :
  - `due_datetime: AAAA-MM-JJTHH:mm:00` pour une tâche normale ;
  - `due_string: "<récurrence> at HH:mm"` pour une tâche récurrente, afin de
    **préserver la récurrence** ;
- les tâches sont donc triées par heure dans Todoist ;
- le titre reste propre (`Trier les cartons`, sans `· 09:00`).

Route : `POST /api/day/times`. Appliquée après « Réorganiser », un déplacement,
un ajout ou un report dans le plan.

## Itération 29 — écrans plein viewport

La page n'est plus un long défilement. Six onglets pleine hauteur :

- **Aujourd’hui** : résumé, KPI et résumé du widget ;
- **Tâches** : liste compacte des tâches du jour ;
- **Ordre** : plan figé, horaires et rappels ;
- **Planifier** : charge et propositions du jour ;
- **Nettoyage** : propositions de nettoyage/corbeille ;
- **Projets** : diagnostic, insights et explorateur.

La page elle-même ne défile plus : chaque écran occupe la hauteur disponible et
défile indépendamment si son contenu dépasse. L'onglet actif est mémorisé.

Les réglages d'horaires et le bouton **« Réorganiser la journée »** sont sur
l'écran **Ordre**, avec un état vide explicite tant qu'aucun ordre n'a été généré.
Après « Réorganiser », l'app bascule automatiquement sur **Ordre**.

### Correctif 0.29.1 — heure de début recalée

- Si l'heure de début réglée est déjà passée **aujourd'hui**, elle est calée sur
  l'heure actuelle (arrondie aux 5 minutes suivantes) au moment de
  « Réorganiser », et le champ **Début tél.** se met à jour.
- Le calcul est fait côté serveur (`clampScheduleToNow`) et dans le navigateur :
  une page restée ouverte ne peut plus produire un ordre qui commence dans le
  passé.
- La préférence de départ est mémorisée séparément (`basePhoneStart`) : le
  calage automatique d'hier n'est pas réutilisé le lendemain.
- Aucun changement pour les jours passés, futurs, ou après l'heure de fin.

> **Aperçu ngrok uniquement.** Cette itération est testée en local via ngrok. Aucun
> push Git ni déploiement Orkestr tant que l'utilisateur n'a pas donné son accord.

## Itération 30 — reports fiables et journée qui déborde

### Plusieurs reports d'affilée

Quand plusieurs propositions de report sont validées dans **Planifier** :

- la réécriture des horaires attend et relit le **dernier plan enregistré** ;
- `POST /api/day/times` refuse de réécrire une tâche dont l'échéance a changé
  entre-temps : un report déjà validé ne peut plus être annulé par une ancienne
  planification ;
- la tâche disparaît aussi de « Déjà prévu ce jour » et des listes locales, puis
  l'aperçu est rafraîchi en arrière-plan.

### Journée trop chargée dans « Ordre »

- Le calcul part de l'**ordre de priorité** : les tâches importantes sont gardées
  en premier.
- Si le total dépasse l'heure de fin (pauses et déjeuner compris), l'app renvoie
  `postpone` : les tâches qui débordent, les moins importantes d'abord, avec une
  date de report suggérée (premier jour futur qui a encore de la place).
- Une tâche importante qui déborde est aussi proposée : l'utilisateur tranche.
- L'écran **Ordre** affiche « Pas assez de place pour tout » avec, pour chaque
  tâche, la date proposée et un bouton **Reporter**.
- Après un report, le plan et les horaires restants sont recalculés.
- Route : `POST /api/day/report` (écriture uniquement après clic sur Reporter).

## Itération 31 — sous-tâches avant leur tâche parente

L'ordre du jour inclut désormais **tout l'arbre des sous-tâches** des tâches du
jour (tous les niveaux, même sans échéance propre) et applique un parcours
**post-ordre** :

- le niveau le plus profond est ordonné d'abord ;
- on remonte niveau par niveau ;
- la tâche parente / racine est toujours **après** ses sous-tâches ;
- l'ordre relatif entre frères (priorité, IA, manuel) est conservé.

Détails :

- `listDayTasks` ajoute les descendants avec `parent_id`, `depth` et
  `is_subtask` ;
- `priorityOrder`, l'ordre d'exécution IA et toutes les variantes (Exécution,
  Priorité, Courtes d'abord, Départ décalé) passent par `subtasksFirstOrder` ;
- le déplacement manuel ▲/▼ réapplique la règle ;
- les propositions de report ne ciblent jamais une sous-tâche seule : c'est la
  tâche racine qui est proposée ;
- l'écran **Ordre** marque les sous-tâches avec `↳` et le nom du parent.

## Itération 32 — horaires bornés et reports partiels

- La planification **s'arrête à l'heure de fin** : plus aucun horaire après 17 h
  (ou l'heure réglée), donc plus de journée à 46 h.
- Les tâches qui ne tiennent plus restent **non planifiées** (sans horaire) au
  lieu de glisser après minuit.
- Une sous-tâche qui rentre reste planifiée ; quand la suite d'un arbre ne tient
  plus, c'est la **tâche racine** qui est proposée au report, avec :
  - le nombre de sous-tâches déjà gardées aujourd'hui ;
  - le nombre de sous-tâches restantes et leurs minutes ;
  - la date du premier jour qui a de la place.
- Le bouton **Reporter** déplace la racine **et ses sous-tâches non planifiées**
  vers la nouvelle date, tout en laissant les sous-tâches déjà planifiées
  aujourd'hui.
- Les tâches non planifiées n'affichent plus `null–null` : seulement le badge
  « Non planifié » et leur durée.
- Les rappels ignorent les tâches non planifiées (pas d'heure nulle).
- Le déplacement manuel recalcule avec la même règle d'arrêt à la fin de journée.

## Itération 33 — une tâche parente n’a pas de créneau propre

- Quand une tâche contient des sous-tâches dans le plan, elle ne réserve plus de
  durée : ses créneaux sont ceux de ses sous-tâches, récursivement.
- Son horaire affiché devient **« fin HH:MM »**, égal à la fin de la dernière
  sous-tâche de son arbre, et elle porte le badge **« Fin des sous-tâches »**.
- Le temps du parent (souvent surestimé) ne gonfle donc plus la journée et ne
  provoque plus de faux dépassements.
- Le recalcul après déplacement manuel applique la même règle.

## Itération 34 — temps d’attente et tâches en parallèle

Le prompt d’ordre demande maintenant à l’IA de repérer les tâches avec un temps
passif (machine, four, cuisson, séchage, trempage, téléchargement, réponse
attendue…) :

- `minutes` = temps **actif** seulement ;
- `wait_minutes` = temps d’attente passif (0 à 480) ;
- `parallel_with` = jusqu’à 3 tâches faisables pendant cette attente, placées
  juste après dans l’ordre pour remplir le temps mort.

L’écran **Ordre** affiche :

- `⏳ 60 min d’attente · prêt à 15:05` sur la tâche concernée ;
- `↔ Pendant l’attente : « Trier le linge », « Répondre au mail »`.

Les identifiants inconnus, les doublons et l’auto-référence sont filtrés. Le
temps d’attente n’est pas compté comme du temps actif dans le planning.

## Itération 35 — reporter une sous-tâche au lendemain

Dans l’écran **Ordre**, chaque ligne a un bouton **⏭** « Reporter au lendemain » :

- la tâche choisie passe au jour suivant ;
- sa **tâche principale** et **tous ses ancêtres** sont reculés aussi, car un
  parent ne peut pas finir avant ses sous-tâches ;
- une échéance déjà plus lointaine n’est jamais avancée : on prend la plus
  tardive entre la date actuelle du parent et le lendemain ;
- les tâches reportées quittent le plan du jour, et les horaires restants sont
  recalculés.

Route : `POST /api/day/report` avec `with_ancestors: true`. La réponse renvoie
`task_ids` pour mettre à jour l’écran sans recharger.

## Itération 36 — préparation avant le public et report de branche

### Douche / soin avant une apparition publique

Le prompt d’ordre connaît maintenant le profil : la personne est réservée en
public et a besoin d’un temps de préparation (douche, soin, tenue) avant de se
montrer.

- L’IA marque les tâches publiques (rendez-vous, entretien, cours, présentation,
  réunion, guichet, sortie, photo…) avec `public: true` et `prep_minutes: 30`.
- Le planning **réserve ce temps juste avant** la tâche : son horaire de début
  est décalé d’autant, et la ligne affiche `🪞 30 min de préparation avant`.
- Si une tâche « douche / soin » existe, l’IA la place juste avant.
- `LIFE_CONTEXT.md` contient une section « Apparence et vie publique » pour que
  les autres fonctions IA (suggestions, préparation) en tiennent compte.
- Le temps de préparation est compté dans la journée et peut déclencher un report
  si la journée ne tient plus.

### Reporter toute une branche au lendemain

Le bouton **⏭** de l’écran Ordre envoie `with_branch: true` :

- la tâche choisie passe au lendemain ;
- **toutes ses sous-tâches** (descendance complète) suivent ;
- ses **parents / ancêtres** sont reculés aussi ;
- une échéance déjà plus lointaine n’est jamais avancée.

## Itération 37 — ordre cohérent après report et tâches du widget

Deux causes de désordre après un report :

- le plan enregistré était seulement filtré, sans être reconstruit ;
- une tâche ajoutée/déplacée dans Todoist pouvait ne pas être dans ce plan.

Correctifs :

- après un report (bouton ⏭ ou panneau), l’ordre est **recalculé sans IA** à
  partir de l’état actuel de Todoist : priorité, hiérarchie, horaires, pauses et
  déjeuner sont refaits, et les horaires sont réécrits ;
- au rendu de l’écran Ordre, si le plan ne contient pas toutes les tâches
  visibles dans le widget (ou contient une tâche qui n’existe plus), il est
  **recalculé automatiquement** ;
- l’ordre sans IA inclut **toutes** les tâches du widget et leurs sous-tâches,
  avec un message explicite « Ordre recalculé sans IA » ;
- une sous-tâche due aujourd’hui est incluse **même si son parent n’est pas
  planifié** : son parent container finit alors à la fin de sa dernière
  sous-tâche à faire, jamais à celle d’une sous-tâche déjà cochée ;
- le recalcul automatique réécrit aussi les heures Todoist pour corriger le
  parent ;
- nouvelle option serveur `ai: false` sur `POST /api/day/order` pour ce
  recalcul déterministe.

## Carnet « Notes & idées » pour OpenCode

En bas à droite, un bouton ouvre un petit carnet. On y note en une phrase une
**amélioration**, un **bug**, une **note** ou une **idée**. Les notes sont **stockées
côté serveur** dans `data/assistant-notes.json` (chemin surchargeable avec
`ASSISTANT_NOTES_FILE`) :

- elles **survivent** aux rechargements et aux redémarrages du serveur local ;
- elles restent **lisibles par l'agent OpenCode** à la prochaine demande sur le projet ;
- le bouton **« Copier pour OpenCode »** produit un prompt prêt à coller (liste des
  notes en attente + consigne de tout implémenter puis de lister ce qui a été fait) ;
- `GET /api/notes/export` renvoie la liste en Markdown.

Routes : `GET/POST /api/notes`, `PATCH/DELETE /api/notes/:id`,
`POST /api/notes/clear-done`.

## Prérequis

- Node.js **22 ou plus** (testé avec Node 22).
- Un compte Todoist personnel.
- Un jeton API Todoist : *Paramètres → Intégrations → Développeur → Jeton API*.
  - Itérations 1–2 (lecture) : `data:read` suffit.
  - Itération 3 (écritures) : `data:read_write`. Un jeton personnel couvre déjà tout.

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
| `WRITES_ENABLED` | non | `true` | Autorise les écritures Todoist **après validation** d'une proposition. `false` = lecture seule. |
| `PROPOSALS_MAX_PER_TYPE` | non | `15` | Nombre maximum de propositions par type. |
| `PROPOSALS_MAX_TOTAL` | non | `40` | Nombre maximum de propositions affichées au total. |
| `PROPOSAL_DUE_OFFSET_DAYS` | non | `7` | Décalage par défaut proposé pour dater une tâche ancienne. |
| `OPENROUTER_API_KEY` | non | — | Clé OpenRouter. Sans elle, l'IA est désactivée (mode règles). |
| `AI_MODEL` | non | `deepseek/deepseek-v4.1-flash` | Modèle utilisé pour proposer les échéances. |
| `AI_MAX_TOKENS` | non | `8000` | Budget de génération (raisonnement + JSON). |
| `AI_REASONING_MAX_TOKENS` | non | `400` | Plafond du raisonnement du modèle. |
| `AI_MAX_PROPOSALS` | non | `5` | Nombre maximum de propositions pour un jour donné. |
| `AI_MAX_NEW_TASKS` | non | `5` | Nombre maximum de nouvelles tâches suggérées pour une journée. |
| `LIFE_CONTEXT_FILE` | non | `LIFE_CONTEXT.md` | Fichier de contexte de vie/progression. |
| `AI_TIMEOUT_MS` | non | `90000` | Délai maximal d'un appel au modèle. |
| `AI_CACHE_TTL_MINUTES` | non | `30` | Durée de cache des propositions IA. |
| `AI_ENABLED` | non | `true` | `false` désactive l'IA même si la clé est présente. |
| `CAPACITY_HORIZON_DAYS` | non | `14` | Nombre de jours couverts par le plan de charge. |
| `CAPACITY_MAX_LARGE` | non | `1` | Nombre maximum de grosses tâches par jour. |
| `CAPACITY_MAX_MEDIUM` | non | `3` | Nombre maximum de tâches moyennes par jour. |
| `CAPACITY_MAX_SMALL` | non | `5` | Nombre maximum de petites tâches par jour. |
| `AI_ALLOW_SPLITS` | non | `true` | Autorise l'IA à proposer de scinder une grosse tâche. |
| `CLEANUP_ENABLED` | non | `true` | Active la détection de nettoyage (doublons, fantômes, orphelines). |
| `CLEANUP_GHOST_DAYS` | non | `365` | Âge minimum pour déclarer une tâche « fantôme ». |
| `CLEANUP_MAX_PER_KIND` | non | `10` | Nombre maximum de suppressions proposées par catégorie. |
| `CLEANUP_MAX_TOTAL` | non | `25` | Nombre maximum total de suppressions proposées. |
| `CLEANUP_RECURRING_MIN_AGE_DAYS` | non | `30` | Âge minimum d'une récurrence peu accomplie. |
| `CLEANUP_RECURRING_MAX_COMPLETIONS` | non | `2` | Maximum de réalisations sur la période pour signaler une récurrence. |
| `PREP_MAX_ITEMS` | non | `3` | Nombre maximum de tâches de préparation proposées pour une tâche. |
| `DECOMPOSE_MAX_ITEMS` | non | `5` | Nombre maximum de sous-tâches proposées par le découpage assisté. |
| `ASSISTANT_NOTES_FILE` | non | `data/assistant-notes.json` | Fichier JSON du carnet de notes. |
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

Les tests unitaires couvrent l'analyse des dates de titre, la construction du résumé
(filtrage des archives, cas de date invalide), le diagnostic des projets (signaux,
verdicts, agrégation par action), le moteur de propositions (liste à puces, échéances,
plafonds, identifiants stables), la couche IA (parsing tolérant, validation stricte des
réponses par jour, respect de la charge autorisée, reports, scissions), le moteur de capacité (estimation de taille, plan de charge 1-3-5), le check-in (réduction de
charge selon l'état) et le nettoyage guidé (fantômes, doublons, orphelines).

## Déploiement sur Orkestr

Orkestr construit une image Docker à partir du dépôt. Le `Dockerfile` fourni est utilisé
tel quel ; l'application écoute sur `0.0.0.0:$PORT`.

1. **Pousser le code** sur GitHub, GitLab, Bitbucket ou Codeberg. Un dépôt **public** est
   cloné directement ; un dépôt privé nécessite une connexion au fournisseur Git.
2. (Dépôt privé uniquement) Dans Orkestr, **Settings → Connected Providers** : connecter
   le fournisseur Git.
3. **Projects → New Project** : choisir le dépôt et la branche (`main`).
   Orkestr détecte Node/Express et le port. Le plan gratuit suffit (1 projet,
   1 environnement).
4. Ouvrir l'environnement **production**, puis **Environment Variables** et ajouter :
   - `TODOIST_API_TOKEN`
   - `APP_PASSWORD`
   - `SESSION_SECRET`
   - `APP_TIMEZONE` = `Europe/Zurich` (l'instance en ligne utilise `Europe/Zurich` ; le
     défaut du code reste `Europe/Paris`)
   Ne pas définir `TODOIST_BASE_URL`.
5. Cliquer **Deploy** et suivre les logs jusqu'au statut **Live**.
6. L'application est disponible sur `https://<slug>.orkestr.run`.
   L'URL `/healthz` doit répondre `{"ok":true,...}`.

Toute modification d'une variable d'environnement nécessite un nouveau déploiement.

> **Auto-déploiement.** Le redéploiement automatique à chaque `git push` n'est actif que
> si le dépôt est relié à Orkestr via l'application GitHub (qui installe aussi le webhook
> signé). Sinon, après un `git push`, lancer un déploiement depuis la console Orkestr
> (**Deploy**) ou via l'API :
>
> ```bash
> curl -X POST \
>   "https://api.orkestr.eu/api/v1/projects/<project_id>/deployments?environment_id=<env_id>" \
>   -H "Authorization: Bearer <ork_token>"
> ```

## Vérification sur téléphone (itérations 1 à 4)

1. Ouvrir `https://<slug>.orkestr.run` : la page de connexion s'affiche.
2. Entrer un mauvais mot de passe : le message « Mot de passe incorrect. » apparaît.
3. Entrer le bon mot de passe : le tableau de bord « Ton Todoist, en clair. » s'affiche.
4. Vérifier que le nombre de projets et de tâches correspond à ton compte Todoist.
5. Dans **Planifier par jour**, la bande **« Charge par jour »** s'affiche en haut, et le
   jour du jour est présélectionné.
6. Ouvrir le **check-in** « Comment te sens-tu ? », choisir par exemple **Malade** +
   **Épuisé** + **Moins d'1 h**, puis **Adapter ma journée** : l'objectif du jour baisse
   (ex. « 0 gros · 0 moyens · 3 petits ») et l'IA propose surtout de **reporter** des tâches.
7. Valider un report ou un ajout : la place du jour se met à jour, **les autres cartes
   restent**.
8. Cliquer un autre jour : les propositions sont différentes et adaptées (et le check-in y
   est indépendant).
7. Vérifier dans l'app Todoist que la modification est bien là.
8. Dans **Diagnostic des projets**, vérifier le classement et les filtres.
9. Ouvrir un projet dans **Explorer** : sections et sous-tâches apparaissent.
10. Appuyer sur **Exporter** : le fichier `todoist-export-….json` contient aussi les
    propositions et le diagnostic.
11. Se déconnecter : retour à la page de connexion.

> Astuce : pour tester sans risque, mets `WRITES_ENABLED=false` : l'app reste entièrement
> fonctionnelle mais refuse toute écriture.

## Structure

```
server.js              démarrage HTTP
src/app.js             routes Express, sécurité, gestion d'erreurs
src/auth.js            mot de passe + cookie de session signé
src/config.js          lecture des variables d'environnement
src/todoist.js         client API Todoist (lectures + écritures, retries, erreurs typées)
src/snapshot.js        normalisation, statistiques, dates dérivées
src/diagnosis.js       verdicts, signaux et propositions par projet
src/capacity.js        estimation de taille et plan de charge 1-3-5
src/checkin.js         questionnaire du jour et charge autorisée
src/feedback.js        retour sur les propositions ignorées (apprentissage)
src/recycleBin.js      corbeille des tâches supprimées (restauration)
src/proposals.js       génération des propositions (pure)
src/applyProposal.js   exécution d'une proposition + vérification via l'API
src/ai.js              client OpenRouter (appel au modèle)
src/aiProposals.js     condensé, invite, validation et cache des propositions IA
src/prepare.js         préparation et découpage assisté d'une tâche (IA)
src/subtaskOrder.js    ordre logique récursif des sous-tâches (IA)
src/renumber.js        renumérotation des sous-tâches après ajout/suppression
src/dayOrder.js        ordre, durées, contextes et planifications horaires (IA)
src/taskSuggestions.js suggestions de nouvelles tâches (IA, création sur validation)
src/lifeContext.js     lecture de LIFE_CONTEXT.md + journal de progression
src/taskTitles.js      horaires inscrits/retirés dans le titre des tâches
src/reminders.js       rappels Todoist natifs (création, remplacement, suppression)
src/assistantNotes.js  carnet de notes persistant pour OpenCode
src/exportService.js   orchestration + cache mémoire
src/dates.js           analyse des conventions de date
views/                 pages HTML (connexion, tableau de bord)
public/                CSS, JS, manifest PWA, icônes et service worker
test/                  tests unitaires (node:test)
LIFE_CONTEXT.md        contexte de vie/projets lu par l'agent OpenCode
AGENTS.md              consignes de travail de l'agent
```

## Sécurité

- Mot de passe comparé à temps constant ; 10 tentatives max par IP et par tranche de
  15 minutes.
- Cookie `HttpOnly`, `SameSite=Lax`, `Secure` derrière HTTPS.
- Vérification d'origine et en-tête `X-App-Request: 1` sur les requêtes sensibles.
- En-têtes CSP stricts, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`.
- Écritures Todoist **uniquement** après validation individuelle d'une proposition
  présente dans l'instantané courant ; chaque écriture est relue pour vérification.
  Aucun secret dans le dépôt.

## Périmètre

Itérations 1 à 37 terminées : export, lecture, diagnostic des projets, planification
**jour par jour** assistée par une IA, **check-in du jour** avec **contexte multi-choix**
et lecture des **filtres Todoist**, scission des tâches **sélective** (on ignore les
morceaux inutiles), **nettoyage guidé** avec corbeille, confort d'usage (tout valider, PWA,
récap hebdo), **retour adaptatif sur les propositions ignorées**, **préparation des tâches**
en sous-étapes datées, **numérotées**, **renumérotées** après suppression et **visibles dans
le widget du jour**, **sélection des préparations à créer**, **exploration des sous-tâches**
avec ajout manuel et **découpage contextualisé** selon le niveau, **ordre logique récursif**
des sous-tâches, **réorganisation de la journée** par priorité et ordre d'exécution,
**planifications horaires et rappels Todoist natifs par tâche**, **horaires de journée
personnalisables**, **pauses entre tâches et pause déjeuner**, **plan de journée figé**
tant que l'utilisateur ne reclique pas, **notes redimensionnables**, **contexte de vie**
pour l'agent, **propositions ancrées dans les projets et échéances**, **ignore sans
rechargement**, **réorganisation manuelle avec recalcul des horaires**, **nettoyage
approfondi progressif** et **carnet de notes éditable** persistant pour OpenCode. Les
itérations suivantes (rituel du matin avec rattrapage
automatique, planificateur de semaine, mémoire des préférences à long terme) ne sont pas
implémentées et seront abordées après retour d'usage.
