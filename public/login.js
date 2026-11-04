'use strict';

/* Connexion : un seul mot de passe, envoyé uniquement au serveur. */

(() => {
  const form = document.getElementById('login-form');
  const input = document.getElementById('password');
  const submit = document.getElementById('login-submit');
  const toggle = document.getElementById('toggle-password');
  const errorBox = document.getElementById('login-error');
  const configAlert = document.getElementById('config-alert');

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = !message;
  }

  function setBusy(busy) {
    submit.disabled = busy;
    submit.textContent = busy ? 'Connexion…' : 'Entrer';
    input.disabled = busy;
  }

  toggle?.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    toggle.textContent = show ? 'Masquer' : 'Afficher';
    toggle.setAttribute('aria-pressed', String(show));
    input.focus({ preventScroll: true });
  });

  input?.addEventListener('input', () => showError(''));

  // Affiche un message clair si le serveur n'a pas encore ses variables.
  fetch('/api/session', { headers: { Accept: 'application/json' } })
    .then((response) => response.json())
    .then((payload) => {
      if (payload.authenticated) {
        window.location.replace('/');
        return;
      }
      if (!payload.config_ok) {
        const missing = (payload.missing_env || []).join(', ');
        configAlert.textContent = missing
          ? `Configuration serveur incomplète : ${missing} manque(nt). Ajoute-la dans Orkestr puis redéploie.`
          : 'Configuration serveur incomplète.';
        configAlert.hidden = false;
        if ((payload.missing_env || []).includes('APP_PASSWORD')) {
          input.disabled = true;
          submit.disabled = true;
        }
      }
    })
    .catch(() => {
      // Le formulaire reste utilisable ; l'erreur sera affichée à l'envoi.
    });

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    showError('');
    const password = input.value;
    if (!password) {
      showError('Saisis ton mot de passe.');
      input.focus();
      return;
    }

    setBusy(true);
    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-App-Request': '1',
          Accept: 'application/json',
        },
        body: JSON.stringify({ password }),
      });
      const payload = await response.json().catch(() => null);
      if (response.ok) {
        window.location.replace('/');
        return;
      }
      const message =
        payload?.error?.message ||
        (response.status === 429
          ? 'Trop de tentatives. Réessaie dans quelques minutes.'
          : 'Connexion impossible.');
      showError(message);
      input.select();
    } catch {
      showError('Connexion au serveur impossible. Vérifie le réseau puis réessaie.');
    } finally {
      setBusy(false);
    }
  });
})();
