'use strict';

/**
 * Réglages d'horaires de la journée.
 *
 * La préférence de l'utilisateur (`base`) est séparée de l'heure calée
 * automatiquement pour aujourd'hui (`settings.phoneStart`). Ainsi, une
 * réorganisation tardive ne laisse pas une heure de début périmée pour le
 * lendemain.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ScheduleSettings = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DEFAULTS = Object.freeze({
    phoneStart: '09:00',
    otherStart: '11:00',
    end: '17:00',
    breakMinutes: 10,
    lunchStart: '12:00',
    lunchEnd: '13:00',
  });

  function isClock(value) {
    const match = /^(\d{2}):(\d{2})$/.exec(value || '');
    if (!match) return false;
    return Number(match[1]) <= 23 && Number(match[2]) <= 59;
  }

  function isIsoDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(value || '');
  }

  function minutesOf(value) {
    const [hours, minutes] = String(value).split(':').map(Number);
    return hours * 60 + minutes;
  }

  /** Normalise les réglages stockés pour la journée `today` (AAAA-MM-JJ). */
  function normalize(raw, today) {
    const parsed = raw && typeof raw === 'object' ? raw : {};
    const base = {
      phoneStart: isClock(parsed.basePhoneStart)
        ? parsed.basePhoneStart
        : DEFAULTS.phoneStart,
      otherStart: isClock(parsed.baseOtherStart)
        ? parsed.baseOtherStart
        : DEFAULTS.otherStart,
    };
    const sameDay = isIsoDate(parsed.day) && isIsoDate(today) && parsed.day === today;
    const breakMinutes = Number(parsed.breakMinutes);

    const settings = {
      phoneStart: sameDay && isClock(parsed.phoneStart)
        ? parsed.phoneStart
        : base.phoneStart,
      otherStart: sameDay && isClock(parsed.otherStart)
        ? parsed.otherStart
        : base.otherStart,
      end: isClock(parsed.end) ? parsed.end : DEFAULTS.end,
      breakMinutes: Number.isFinite(breakMinutes)
        ? Math.min(120, Math.max(0, Math.round(breakMinutes)))
        : DEFAULTS.breakMinutes,
      lunchStart: isClock(parsed.lunchStart)
        ? parsed.lunchStart
        : DEFAULTS.lunchStart,
      lunchEnd: isClock(parsed.lunchEnd) ? parsed.lunchEnd : DEFAULTS.lunchEnd,
    };

    // Une fin avant le début n'a pas de sens.
    if (minutesOf(settings.end) <= minutesOf(settings.phoneStart)) {
      settings.end = DEFAULTS.end;
    }

    return {
      settings,
      base,
      day: isIsoDate(today) ? today : null,
    };
  }

  /** Objet à écrire dans le stockage local. */
  function serialize(settings, base, day) {
    const source = settings || {};
    const value = (key) => (isClock(source[key]) ? source[key] : DEFAULTS[key]);
    const breakMinutes = Number(source.breakMinutes);
    return {
      phoneStart: value('phoneStart'),
      otherStart: value('otherStart'),
      end: value('end'),
      breakMinutes: Number.isFinite(breakMinutes)
        ? Math.min(120, Math.max(0, Math.round(breakMinutes)))
        : DEFAULTS.breakMinutes,
      lunchStart: value('lunchStart'),
      lunchEnd: value('lunchEnd'),
      day: isIsoDate(day) ? day : null,
      basePhoneStart: isClock(base?.phoneStart)
        ? base.phoneStart
        : DEFAULTS.phoneStart,
      baseOtherStart: isClock(base?.otherStart)
        ? base.otherStart
        : DEFAULTS.otherStart,
    };
  }

  return {
    DEFAULTS,
    isClock,
    isIsoDate,
    normalize,
    serialize,
  };
});
