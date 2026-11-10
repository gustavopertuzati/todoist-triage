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

  const wantedTaskIds = new Set(wanted.map((item) => String(item.taskId)));
  const wantedByTask = new Map(wanted.map((item) => [String(item.taskId), item]));
  const deleteIds = new Set();
  const reusedByTask = new Map();
  const reusedIds = new Set();

  // Réutilise un rappel absolu déjà au bon horaire ; ne supprime que ceux qui
  // doivent réellement changer. Cela évite de recréer tous les rappels à
  // chaque réorganisation (quota Todoist).
  for (const reminder of existing) {
    if (reminder.type !== 'absolute') continue;
    const taskId = String(reminder.item_id);
    const wantedItem = wantedByTask.get(taskId);
    if (wantedItem) {
      if (sameDue(reminder, wantedItem.date, wantedItem.time)) {
        reusedByTask.set(taskId, reminder);
        reusedIds.add(String(reminder.id));
      } else {
        deleteIds.add(String(reminder.id));
      }
    }
  }

  // Et les rappels connus de tâches qui ne sont plus dans le plan.
  for (const entry of knownList) {
    const reminderId = String(entry?.reminderId || '');
    if (!reminderId || reusedIds.has(reminderId)) continue;
    const reminder = existingById.get(reminderId);
    if (!reminder) continue;
    if (entry.taskId && String(reminder.item_id) !== String(entry.taskId)) continue;
    deleteIds.add(reminderId);
  }

  const commands = [];
  const deleteUuids = [];
  const addCommands = [];

  for (const reminderId of deleteIds) {
    const uuid = crypto.randomUUID();
    commands.push({ type: 'reminder_delete', uuid, args: { id: reminderId } });
    deleteUuids.push(uuid);
  }

  for (const item of wanted) {
    const taskId = String(item.taskId);
    const existingReminder = reusedByTask.get(taskId);
    if (existingReminder) {
      continue;
    }
    const tempId = crypto.randomUUID();
    const uuid = crypto.randomUUID();
    commands.push({
      type: 'reminder_add',
      temp_id: tempId,
      uuid,
      args: {
        item_id: taskId,
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
  for (const item of wanted) {
    const reminder = reusedByTask.get(String(item.taskId));
    if (!reminder) continue;
    mapping.push({
      taskId: String(item.taskId),
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
    created: mapping.length,
    reused: 0,
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
