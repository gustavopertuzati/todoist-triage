'use strict';

/**
 * Ordre logique des sous-tâches (itération 14).
 *
 * Pour une tâche, on envoie à l'IA l'arbre complet de ses sous-tâches (tous les
 * niveaux) et on lui demande d'ordonner les enfants de CHAQUE parent dans
 * l'ordre où ils doivent être accomplis. Aucune écriture Todoist : l'ordre est
 * seulement affiché, avec des numéros, dans le détail de la tâche.
 */

const crypto = require('node:crypto');
const { config } = require('./config');
const { chatJson, AiError } = require('./ai');

const SYSTEM_PROMPT = [
  'Tu ordonnes des sous-tâches dans l’ordre logique d’accomplissement.',
  'Tu ne renommes rien, tu ne supprimes rien, tu ne crées rien.',
  'Tu réponds UNIQUEMENT par un objet JSON valide, sans texte autour.',
].join(' ');

const MAX_DEPTH = 8;
const MAX_NODES = 150;

let cache = new Map(); // rootId -> { signature, orders, summary, generatedAt, usage, model }

function signatureOf(value) {
  return crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex');
}

function short(value, max = 180) {
  return String(value || '').trim().slice(0, max);
}

/** Construit l'arbre récursif (profondeur et nombre de nœuds bornés). */
function buildSubtaskDigest(snapshot, rootId) {
  const root = (snapshot.tasks || []).find((task) => task.id === String(rootId));
  if (!root) return null;

  const childrenByParent = new Map();
  for (const task of snapshot.tasks || []) {
    if (task.project_archived) continue;
    const key = task.parent_id || null;
    if (!childrenByParent.has(key)) childrenByParent.set(key, []);
    childrenByParent.get(key).push(task);
  }
  // Même ordre de départ que l'interface (ordre Todoist).
  for (const list of childrenByParent.values()) {
    list.sort(
      (a, b) =>
        String(a.order_key || '').localeCompare(String(b.order_key || '')) ||
        Number(a.child_order ?? 0) - Number(b.child_order ?? 0) ||
        String(a.display_title || a.content || '').localeCompare(
          String(b.display_title || b.content || ''),
          'fr-FR'
        )
    );
  }

  let count = 0;
  const truncated = [];

  function build(task, depth) {
    if (count >= MAX_NODES || depth > MAX_DEPTH) {
      truncated.push(task.id);
      return { id: task.id, title: short(task.display_title || task.content), children: [] };
    }
    count += 1;
    const children = (childrenByParent.get(task.id) || []).map((child) =>
      build(child, depth + 1)
    );
    return {
      id: task.id,
      title: short(task.display_title || task.content),
      note: short(task.description, 240) || null,
      due_date: task.due_date || null,
      children,
    };
  }

  return {
    root_id: root.id,
    title: short(root.display_title || root.content, 200),
    max_depth: MAX_DEPTH,
    max_nodes: MAX_NODES,
    truncated,
    tree: build(root, 0),
  };
}

function buildOrderPrompt(digest) {
  return [
    'Voici une tâche et l’arbre complet de ses sous-tâches.',
    'Ordonne les enfants de CHAQUE parent dans l’ordre logique d’accomplissement :',
    'les prérequis d’abord, puis l’exécution, puis la vérification/clôture.',
    '',
    'Règles :',
    '- Utilise uniquement les identifiants présents dans l’arbre.',
    '- Pour chaque parent qui a des enfants, renvoie TOUS ses enfants directs, ordonnés.',
    '- Ne renomme rien, n’invente aucune tâche, n’en supprime aucune.',
    '- Si un niveau n’a qu’un enfant, tu peux l’omettre.',
    '',
    'Réponds EXACTEMENT par ce JSON :',
    '{"summary":"phrase courte expliquant l’ordre choisi",',
    ' "orders":{"<id_parent>":["<id_enfant_1>","<id_enfant_2>"]}}',
    '',
    'Données :',
    JSON.stringify(digest),
  ].join('\n');
}

/**
 * Valide la réponse : chaque liste doit contenir les vrais enfants du parent.
 * Les identifiants inconnus sont ignorés, les oubliés sont ajoutés à la fin
 * dans l'ordre d'origine (pour ne jamais perdre une sous-tâche).
 */
function validateOrderResponse(parsed, digest) {
  const orders = {};
  let changed = 0;

  const requested =
    parsed && typeof parsed.orders === 'object' && parsed.orders ? parsed.orders : {};

  function visit(node) {
    if (node.children.length > 0) {
      const ids = node.children.map((child) => child.id);
      const proposed = Array.isArray(requested[node.id]) ? requested[node.id] : [];
      const seen = new Set();
      const ordered = [];

      for (const rawId of proposed) {
        const id = String(rawId);
        if (!ids.includes(id) || seen.has(id)) continue;
        seen.add(id);
        ordered.push(id);
      }
      for (const id of ids) if (!seen.has(id)) ordered.push(id);

      if (ordered.some((id, index) => id !== ids[index])) changed += 1;
      orders[node.id] = ordered;

      const byId = new Map(node.children.map((child) => [child.id, child]));
      for (const id of ordered) visit(byId.get(id));
    } else {
      for (const child of node.children) visit(child);
    }
  }

  visit(digest.tree);

  return {
    orders,
    changed,
    summary:
      typeof parsed?.summary === 'string' && parsed.summary.trim()
        ? parsed.summary.trim().slice(0, 300)
        : null,
  };
}

async function generateSubtaskOrder(snapshot, rootId, { force = false } = {}) {
  if (!config.aiEnabled) {
    throw new AiError('AI_DISABLED', 'L’IA n’est pas configurée (OPENROUTER_API_KEY manquant).');
  }

  const root = (snapshot.tasks || []).find((task) => task.id === String(rootId));
  if (!root || root.project_archived) {
    throw new AiError('TASK_NOT_FOUND', 'Tâche introuvable (elle a peut-être changé).');
  }

  const digest = buildSubtaskDigest(snapshot, root.id);
  const hasChildren = (digest?.tree?.children || []).length > 0;
  if (!hasChildren) {
    return {
      orders: {},
      changed: 0,
      summary: 'Aucune sous-tâche à ordonner.',
      cached: false,
      usage: null,
    };
  }

  const signature = signatureOf(digest);
  const cached = cache.get(String(root.id));
  const fresh =
    cached &&
    cached.signature === signature &&
    (config.aiCacheTtlMs === 0 || Date.now() - cached.generatedAt < config.aiCacheTtlMs);

  if (fresh && !force) return { ...cached, cached: true };

  const { data, usage, model } = await chatJson({
    system: SYSTEM_PROMPT,
    user: buildOrderPrompt(digest),
  });

  const { orders, changed, summary } = validateOrderResponse(data, digest);
  const entry = {
    signature,
    orders,
    changed,
    summary,
    generatedAt: Date.now(),
    usage,
    model,
  };
  cache.set(String(root.id), entry);

  return { ...entry, cached: false };
}

function clearOrderCache() {
  cache = new Map();
}

module.exports = {
  SYSTEM_PROMPT,
  buildSubtaskDigest,
  buildOrderPrompt,
  validateOrderResponse,
  generateSubtaskOrder,
  clearOrderCache,
};
