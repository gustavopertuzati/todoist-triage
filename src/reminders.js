'use strict';

/**
 * Rappels Todoist natifs (itération 18).
 *
 * On crée un rappel absolu par tâche planifiée, à l'heure calculée par le
 * planning de la journée. Les rappels existants identiques (même tâche, même
 * heure) sont réutilisés pour éviter les doublons. Seuls les rappels connus du
 * client (mapping localStorage) sont supprimés avant recalcul.
 */

const crypto = require('node:crypto');
const { syncRequest, syncCommands } = require('./todoist');

function dueString(date, time) {
  return `${date}T${time}:00`;
}

function sameDue(reminder, date, time) {
  const value = reminder?.due?.date;
  return typeof value === 'string' && value.slice(0, 16) === `${date}T${time}`;
}

async function listReminders() {
  const result = await syncRequest({
    sync_token: '*',
    resource_types: JSON.stringify(['reminders']),
  });
  return Array.isArray(result?.reminders)
    ? result.reminders.filter((reminder) => reminder && reminder.is_deleted !== true)
    : [];
}

/**
 * Remplace les rappels d'un plan.
 * @param {{items:{taskId:string,date:string,time:string}[], known:{taskId:string,reminderId:string}[], timezone:string}} params
 */
async function replaceReminders({ items, known = [], timezone = 'Europe/Paris' }) {
  const wanted = Array.isArray(items) ? items.filter((item) => item.taskId && item.date && item.time) : [];
  const knownList = Array.isArray(known) ? known : [];
  const existing = await listReminders();
  const existingById = new Map(existing.map((reminder) => [String(reminder.id), reminder]));

  // Réutilise un rappel existant au même moment pour la même tâche.
  const reused = new Map(); // taskId -> reminder
  for (const item of wanted) {
    const match = existing.find(
      (reminder) =>
        String(reminder.item_id) === String(item.taskId) &&
        sameDue(reminder, item.date, item.time)
    );
    if (match) reused.set(String(item.taskId), match);
  }

  const commands = [];
  const deleteUuids = [];
  const addCommands = [];
  const reusedIds = new Set([...reused.values()].map((reminder) => String(reminder.id)));

  for (const entry of knownList) {
    const reminderId = String(entry?.reminderId || '');
    if (!reminderId || reusedIds.has(reminderId)) continue;
    const reminder = existingById.get(reminderId);
    if (!reminder) continue;
    if (entry.taskId && String(reminder.item_id) !== String(entry.taskId)) continue;
    const uuid = crypto.randomUUID();
    commands.push({ type: 'reminder_delete', uuid, args: { id: reminderId } });
    deleteUuids.push(uuid);
  }

  for (const item of wanted) {
    if (reused.has(String(item.taskId))) continue;
    const tempId = crypto.randomUUID();
    const uuid = crypto.randomUUID();
    commands.push({
      type: 'reminder_add',
      temp_id: tempId,
      uuid,
      args: {
        item_id: String(item.taskId),
        type: 'absolute',
        due: { date: dueString(item.date, item.time), timezone },
      },
    });
    addCommands.push({ tempId, uuid, item });
  }

  let syncStatus = {};
  let tempMapping = {};
  if (commands.length > 0) {
    const result = await syncCommands(commands);
    syncStatus = result?.sync_status || {};
    tempMapping = result?.temp_id_mapping || {};
  }

  const errors = [];
  for (const command of commands) {
    const status = syncStatus[command.uuid];
    if (status && status !== 'ok') errors.push({ type: command.type, status: String(status).slice(0, 80) });
  }

  const mapping = [];
  for (const [taskId, reminder] of reused.entries()) {
    const item = wanted.find((entry) => String(entry.taskId) === String(taskId));
    mapping.push({
      taskId: String(taskId),
      reminderId: String(reminder.id),
      date: item.date,
      time: item.time,
    });
  }
  for (const add of addCommands) {
    const reminderId = tempMapping[add.tempId];
    if (!reminderId) continue;
    mapping.push({
      taskId: String(add.item.taskId),
      reminderId: String(reminderId),
      date: add.item.date,
      time: add.item.time,
    });
  }

  const deleted = deleteUuids.filter((uuid) => syncStatus[uuid] === 'ok').length;
  return {
    created: mapping.length - reused.size,
    reused: reused.size,
    deleted,
    mapping,
    errors,
  };
}

module.exports = {
  listReminders,
  replaceReminders,
  dueString,
  sameDue,
};
