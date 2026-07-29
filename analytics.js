/* ==========================================================================
   CuriousScout — PostHog analytics
   --------------------------------------------------------------------------
   One shared file for the whole site, loaded by the landing page and by every
   game. Answers "which games are people actually playing?" with three events:

     game_card_clicked   someone clicked a game on the landing page  (interest)
     game_opened         a game page was actually loaded             (opens)
     game_engaged        they were still there 30 seconds later      (real play)
     game_closed         best-effort, carries how long they stayed

   The open -> engaged pair is the useful one: opens alone can't tell a game
   people love from one they bounced off in two seconds.

   SETUP: fill in the two values below. Until POSTHOG_KEY is set, nothing is
   sent anywhere — events are logged to the browser console instead, so you can
   confirm the wiring works before any data leaves the page.
   ========================================================================== */
(function () {
  'use strict';

  /* ---------------------------------------------------------------- config */

  // From PostHog: Settings -> Project -> Project API Key. Starts with "phc_".
  // This key is meant to be public and ships in client-side code — it can only
  // send events in, never read your data out, so it is safe in a public repo.
  var POSTHOG_KEY = 'phc_rB3PRLNBbB3jXc9LQDkAR739nC4VaJPrrKey45NKzVDC';

  // 'us' or 'eu' — must match the region the project was created in, or events
  // go to a host that doesn't know the key and are silently dropped.
  var REGION = 'eu';

  // The behaviour-defaults bundle PostHog generated with this project's snippet.
  var PH_DEFAULTS = '2026-05-30';

  var HOSTS = {
    us: { api: 'https://us.i.posthog.com', assets: 'https://us-assets.i.posthog.com' },
    eu: { api: 'https://eu.i.posthog.com', assets: 'https://eu-assets.i.posthog.com' }
  };

  /* ------------------------------------------------------------ what page? */

  /**
   * Name the game after its directory, so adding a new game needs no edit
   * here. "/math%20mine/" -> "math mine", site root -> "landing".
   */
  function detectGame() {
    var parts = location.pathname.split('/').filter(Boolean);
    if (parts.length && /\.html?$/i.test(parts[parts.length - 1])) parts.pop();
    var dir = parts[parts.length - 1];
    if (!dir) return 'landing';
    try { return decodeURIComponent(dir); } catch (e) { return dir; }
  }

  var GAME = detectGame();
  var IS_LANDING = GAME === 'landing';

  // Opening a file directly (file://) or serving it locally is development, not
  // a real visit. Those would otherwise pollute the numbers you're trying to read.
  var IS_DEV = location.protocol === 'file:' ||
    /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/.test(location.hostname) ||
    /\.local$/.test(location.hostname);

  // Escape hatch for smoke-testing the real pipeline from a local server:
  // load any page with ?analytics=live to send for real. Without it, local
  // visits only ever log to the console.
  var FORCE_LIVE = /[?&]analytics=live\b/.test(location.search);

  var CONFIGURED = /^phc_/.test(POSTHOG_KEY);
  var LIVE = CONFIGURED && (!IS_DEV || FORCE_LIVE);

  /* ----------------------------------------------------------------- send */

  var queue = [];
  var ready = false;
  var dead = false;          // library blocked (ad blocker, offline) — give up quietly

  function send(name, props) {
    var payload = { game: GAME, page_title: document.title };
    if (props) for (var k in props) if (Object.prototype.hasOwnProperty.call(props, k)) payload[k] = props[k];

    if (!LIVE) {
      // Dev / not-yet-configured: show what WOULD be sent.
      var why = !CONFIGURED ? 'no key yet' : 'local';
      if (window.console && console.log) console.log('%c[analytics · ' + why + ']', 'color:#ff6fd8', name, payload);
      return;
    }
    if (dead) return;
    if (!ready) { queue.push([name, payload]); return; }
    try { window.posthog.capture(name, payload); } catch (e) { dead = true; }
  }

  // Exposed so a game can add its own events, e.g. track('level_cleared', {level: 3})
  window.track = send;

  /* --------------------------------------------------------------- loading */

  if (LIVE) {
    var s = document.createElement('script');
    s.src = HOSTS[REGION].assets + '/static/array.js';
    s.async = true;
    s.crossOrigin = 'anonymous';

    s.onload = function () {
      if (!window.posthog || !window.posthog.init) { dead = true; queue.length = 0; return; }
      window.posthog.init(POSTHOG_KEY, {
        api_host: HOSTS[REGION].api,
        defaults: PH_DEFAULTS,

        // ---- deliberately conservative, because this site is aimed at kids ----
        // Only the handful of events above are sent. No blanket click/keystroke
        // capture, no screen recording, and no person profiles for anonymous
        // visitors, so there is nothing here that identifies a child.
        autocapture: false,
        disable_session_recording: true,
        // The defaults bundle pulls in surveys.js and would let PostHog pop
        // questionnaires over the games. Not on a site aimed at children.
        disable_surveys: true,
        capture_pageview: true,
        capture_pageleave: true,
        person_profiles: 'identified_only',
        // Honours the browser's Do Not Track signal. This does cost you some
        // data — set to false if you would rather count those visitors.
        respect_dnt: true
      });
      ready = true;
      for (var i = 0; i < queue.length; i++) {
        try { window.posthog.capture(queue[i][0], queue[i][1]); } catch (e) { dead = true; break; }
      }
      queue.length = 0;
    };

    s.onerror = function () { dead = true; queue.length = 0; };
    document.head.appendChild(s);
  }

  /* ---------------------------------------------------------------- events */

  if (IS_LANDING) {
    // Which cards get clicked. Capture phase, so it still fires as the browser
    // starts navigating away.
    document.addEventListener('click', function (e) {
      var el = e.target;
      var card = null;
      while (el && el !== document) {
        if (el.classList && el.classList.contains('card')) { card = el; break; }
        el = el.parentNode;
      }
      if (!card) return;
      var href = (card.getAttribute('href') || '').replace(/\/+$/, '');
      var slug = 'unknown';
      try { slug = decodeURIComponent(href) || 'unknown'; } catch (e2) { slug = href || 'unknown'; }
      var h2 = card.querySelector('h2');
      send('game_card_clicked', {
        target_game: slug,
        target_label: h2 ? h2.textContent.trim() : slug
      });
    }, true);

  } else {
    send('game_opened');

    // Count only time the tab is actually in front — a game left open in a
    // background tab is not someone playing it.
    var visibleSec = 0;
    var engagedAt = 30;
    var engagedSent = false;

    setInterval(function () {
      if (document.hidden) return;
      visibleSec++;
      if (!engagedSent && visibleSec >= engagedAt) {
        engagedSent = true;
        send('game_engaged', { seconds: engagedAt });
      }
    }, 1000);

    // Best effort: browsers do not guarantee anything on the way out, so treat
    // game_closed as a bonus and rely on game_engaged for the real signal.
    window.addEventListener('pagehide', function () {
      send('game_closed', { seconds: visibleSec, engaged: engagedSent });
    });
  }
})();
