# Contexte de vie — à relire par l'agent

Dernière mise à jour : **2026-11-06**

Ce fichier donne à l'agent le contexte réel des projets en cours, de leur avancement et de
leurs blocages. Il doit être lu **avant** de proposer un plan, une priorisation ou des
actions, et servir à éviter les conseils déconnectés de la réalité.

## Projets en cours

### Configurer OpenCode AI & agents (OpenRouter / Groq) — 70 %

- Objectif : contrôler le téléphone et déléguer des actions, mais de façon **très
  restreinte**.
- Blocage : l'agent ne doit **jamais** toucher WhatsApp, envoyer des mails, ni prendre des
  initiatives de communication sans demande explicite.
- Attendu : actions limitées, réversibles, avec confirmation.

### Suivre les candidatures sur JobOps — 40 %

- Projet personnel hébergé en local pour aider à trouver du travail :
  **<https://github.com/DaKheera47/job-ops>** (voir la doc du dépôt).
- Beaucoup de refus. Impression que les IA de recrutement reconnaissent les candidatures
  générées par IA.
- À travailler : trouver une manière de percer leurs filtres sans mentir ni spammer.

### Maintenir les workflows d'automatisation n8n — 10 %

- Les PoCs faits pour Richard ont été supprimés ; démotivation de repartir de zéro.
- Un historique Claude/Gemini existe : possibilité de reprendre à partir de là.
- Blocage : motivation + reconstruction.

#### Workflows n8n déjà structurés (à reconstruire / documenter)

1. **Gestion et retrait du courrier (fiduciaire)**
   - Déclencheur : webhook ou surveillance d'un dossier dès réception d'un PDF numérisé.
   - OCR / agent IA : identifier le client/mandat, le type de document (facture, impôts,
     pli officiel) et les dates d'échéance.
   - Notification client WhatsApp/email : prévenir de la réception, proposer le retrait
     ou l'envoi du scan.
   - Suivi du statut : « en attente de retrait » → « retiré » après validation au guichet.

2. **Alerte et gestion globale des erreurs**
   - Error Trigger sur tous les workflows actifs.
   - Rapport : nom du workflow, ID d'exécution, nœud en échec, horodatage local.
   - Notification multi-canal : email SMTP/Gmail détaillé + alerte mobile
     WhatsApp/Telegram.

3. **Intégrations webhooks & API WhatsApp Meta**
   - Connexion Meta Business, validation des webhooks officiels.
   - Routage des messages entrants vers la fiduciaire ou les assistants intelligents.

### Étudier AWS Developer Associate & LangChain4j/Spring AI — 1 %

- Très peu de motivation pour coder/apprendre depuis le renvoi de la Ville de Genève.
- Comportement actuel : utiliser des agents pour tout faire.
- Blocage : débloquer l'envie d'apprendre et de coder, par petits pas.

### Maintenir le suivi calorique (~1600 kcal/j) sur Lose It! — en cours

- Environ **2500 kcal en trop sur la semaine** ; suivi imprécis.
- Blocage : lassitude de tout peser, oublis, téléphone absent, perte de temps.
- Objectif : tenir une routine simple **2 à 3 semaines** pour automatiser le schéma sans
  peser chaque aliment.

### Faire les séances de sport (NonStop Gym Servette + maison) — 3 %

- Montre Fit 100 S reçue ; abonnement valable jusqu'en avril de l'année prochaine.
- Blocage : quand la charge mentale monte, le sport saute.
- Attendu : éviter les semaines surchargées, adapter les séances, prévoir les rappels.

### Étudier la théorie du permis de conduire (iTheorie) — 80 %

- Objectif : **90 % de réussite en test, de façon constante**, avant la fin de l'année.
- Blocage : manque de confiance, pas de blocage externe.
- Attendu : plus de tests par jour, régularité.

### Entretenir et bouturer les plantes d'intérieur (Chlorophytum / Tradescantia)

- Reste les **violettes**, qui sont en train de mourir. À faire vite.
- Besoin possible de Seb pour les pots ; peut-être faisable seul.

### Avancer le puzzle « Map of the Universe » (1500 pièces) — 0 %

- À faire avec Marco.
- Blocage : difficulté à lui proposer.

## Apparence et vie publique

- Se sent assez réservé / **self-conscious en public**.
- Avant un rendez-vous, un entretien, un cours, une présentation, une réunion,
  un guichet ou une sortie : prévoir un temps de **préparation** (douche, soin,
  tenue) d'environ **30 min**.
- L'ordre du jour réserve ce temps juste avant la tâche publique et affiche
  `🪞 30 min de préparation avant`.
- Si une tâche « douche / soin » existe déjà, la placer avant la tâche publique.

## Règles pour l'agent

- **Ne jamais** envoyer de WhatsApp, SMS, mail ou notification à la place de l'utilisateur
  sans demande explicite et confirmation.
- Ne pas contrôler le téléphone en dehors d'actions très restreintes et réversibles.
- Tenir compte des blocages ci-dessus : proposer des actions petites, concrètes, adaptées à
  la fatigue et à la charge mentale.
- Signaler si une demande risque de surcharger une semaine déjà dense.
- Le contexte doit rester privé : ne pas l'exposer dans l'interface publique de l'app.
