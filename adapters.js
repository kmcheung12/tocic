/**
 * Tocic – adapters.js
 *
 * Each adapter exposes a single interface:
 *
 *   adapter.id          – string identifier
 *   adapter.matches()   – returns true if this adapter should handle the current page
 *   adapter.pairs()     – returns Array<{ userEl, botEl, text }>
 *                           userEl : the user message wrapper element
 *                           botEl  : the bot response wrapper element (may be null if still streaming)
 *                           text   : the user's query text (for the TOC label)
 *
 * All DOM access is READ-ONLY. Adapters never mutate Grok/Claude/X elements.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DOM notes per site (verified from live HTML inspection):
 *
 * grok.com/c/:id
 *   Every turn (user or bot) is:  div[id^="response-"]
 *   User turns carry class:       items-end
 *   Bot  turns carry class:       items-start
 *   User text lives in:           .response-content-markdown (inside the user div)
 *
 * claude.ai/chat/:id
 *   User turns:   div[data-testid="user-message"]
 *   Bot  turns:   the next sibling subtree after the user turn's ancestor
 *   User text:    innerText of the user-message div itself
 *
 *
 * chatgpt.com/c/:id  (also chat.openai.com/c/:id)
 *   Every turn is:        article[data-testid^="conversation-turn-"]
 *   Role identified by:   [data-message-author-role="user" | "assistant"]
 *   User text lives in:   .whitespace-pre-wrap  (inside the user article)
 *   Bot  text lives in:   .markdown             (inside the assistant article)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

(function (global) {
  'use strict';

  // ── Helpers shared across adapters ─────────────────────────────────────────

  /** Walk up from el to find the first ancestor matching selector, max `limit` steps */
  function closest(el, selector, limit) {
    limit = limit || 10;
    var node = el;
    for (var i = 0; i < limit; i++) {
      node = node && node.parentElement;
      if (!node) return null;
      if (node.matches && node.matches(selector)) return node;
    }
    return null;
  }

  /** Return innerText of el, cleaned up */
  function getText(el) {
    return el ? (el.innerText || el.textContent || '').trim() : '';
  }

  // ── Adapter: grok.com ───────────────────────────────────────────────────────
  var grokComAdapter = {
    id: 'grok.com',

    matches: function () {
      return location.hostname === 'grok.com' && /^\/c\//.test(location.pathname);
    },

    pairs: function () {
      var all = Array.from(document.querySelectorAll('div[id^="response-"]'));
      var userEls = all.filter(function (el) { return el.classList.contains('items-end'); });
      var botEls  = all.filter(function (el) { return el.classList.contains('items-start'); });

      return userEls.reduce(function (acc, userEl) {
        var markdown = userEl.querySelector('.response-content-markdown');
        var text = getText(markdown || userEl);
        if (!text) return acc;

        var userIdx = all.indexOf(userEl);
        var botEl = botEls.find(function (b) { return all.indexOf(b) > userIdx; }) || null;

        acc.push({ userEl: userEl, botEl: botEl, text: text });
        return acc;
      }, []);
    }
  };

  // ── Adapter: claude.ai ──────────────────────────────────────────────────────
  var claudeAdapter = {
    id: 'claude.ai',

    matches: function () {
      return location.hostname === 'claude.ai' && /^\/chat\//.test(location.pathname);
    },

    pairs: function () {
      // User messages are reliably marked with data-testid="user-message"
      var userMsgs = Array.from(document.querySelectorAll('[data-testid="user-message"]'));

      return userMsgs.reduce(function (acc, userEl) {
        var text = getText(userEl);
        if (!text) return acc;

        // The user message div sits inside a chain of wrappers.
        // Walk up until we find the turn-level container: a div that is a
        // direct child of the scroller (has a bot-response sibling after it).
        // Heuristic: go up until the parent has multiple children and one of
        // the later siblings contains substantial text (the bot reply).
        var turnRoot = userEl;
        for (var d = 0; d < 8; d++) {
          var parent = turnRoot.parentElement;
          if (!parent) break;
          var siblings = Array.from(parent.children);
          var idx = siblings.indexOf(turnRoot);
          // If there's a next sibling with real content, this parent is the scroller
          if (idx !== -1 && idx + 1 < siblings.length) {
            var nextSib = siblings[idx + 1];
            if (getText(nextSib).length > 20) {
              // turnRoot is the user turn container; nextSib is the bot turn
              acc.push({ userEl: turnRoot, botEl: nextSib, text: text });
              return acc;
            }
          }
          turnRoot = parent;
        }

        // Fallback: no bot turn found yet (still streaming)
        acc.push({ userEl: userEl, botEl: null, text: text });
        return acc;
      }, []);
    }
  };


  // ── Adapter: chatgpt.com ───────────────────────────────────────────────────
  //
  // DOM structure (as of early 2025):
  //
  //   The full conversation is a list of article elements:
  //     article[data-testid^="conversation-turn-"]
  //
  //   Each article contains one turn. The role is identified by:
  //     [data-message-author-role="user"]      ← user turn
  //     [data-message-author-role="assistant"] ← bot turn
  //
  //   User text lives in:  .whitespace-pre-wrap  (inside the user article)
  //   Bot  text lives in:  .markdown             (inside the assistant article)
  //
  //   Turns are ordered in the DOM, so we can pair them by index:
  //   turn 0 (user) → turn 1 (assistant), turn 2 (user) → turn 3 (assistant), …
  //
  //   The page URL is chatgpt.com/c/:id  (also chat.openai.com/c/:id)
  //
  var chatgptAdapter = {
    id: 'chatgpt.com',

    matches: function () {
      var h = location.hostname;
      return (h === 'chatgpt.com' || h === 'chat.openai.com') &&
             /^\/c\//.test(location.pathname);
    },

    pairs: function () {
      // Collect all turn articles in DOM order
      var articles = Array.from(
        document.querySelectorAll('article[data-testid^="conversation-turn-"]')
      );

      // Separate by role
      var userArticles = articles.filter(function (a) {
        return !!a.querySelector('[data-message-author-role="user"]');
      });

      var botArticles  = articles.filter(function (a) {
        return !!a.querySelector('[data-message-author-role="assistant"]');
      });

      return userArticles.reduce(function (acc, userEl) {
        // User text: prefer .whitespace-pre-wrap, fall back to full article text
        var textEl = userEl.querySelector('.whitespace-pre-wrap') ||
                     userEl.querySelector('[data-message-author-role="user"]');
        var text = getText(textEl || userEl);
        if (!text) return acc;

        // Pair with the next bot article that appears after this user article
        var userIdx = articles.indexOf(userEl);
        var botEl = botArticles.find(function (b) {
          return articles.indexOf(b) > userIdx;
        }) || null;

        acc.push({ userEl: userEl, botEl: botEl, text: text });
        return acc;
      }, []);
    }
  };

  // ── Adapter: custom URL (user-defined regex patterns) ──────────────────────
  //
  // When the current page URL matches one of the user-saved patterns, this
  // adapter activates. It treats the page as a document TOC rather than a
  // chat conversation:
  //
  //   - h1 elements become top-level "query" rows (the label in the widget)
  //   - h2/h3 inside each h1 section become sub-headings, indented as usual
  //   - If no h1 exists, h2 is promoted to top level (same logic as extractHeadings)
  //   - The widget shows "Contents" in the siteLabel if no label was given
  //
  // pairs() returns one entry per h1 (or per h2 if no h1 exists), where:
  //   userEl = the heading element itself (scrolled to on click)
  //   botEl  = null (headings are extracted by content.js from the section)
  //   text   = the heading's text
  //
  // Because botEl is null, content.js's extractHeadings() won't find
  // sub-headings. Instead this adapter sets a flag so content.js can use
  // a special "document" mode where it scans between consecutive h1s.
  //
  var customUrlAdapter = {
    id: 'custom',
    _matchedEntry: null,

    matches: function () {
      if (!window.TocicSettings) return false;
      var entry = window.TocicSettings.matchCustomUrl();
      this._matchedEntry = entry;
      return !!entry;
    },

    // Return a label for the widget header (the matched entry's label or hostname)
    getLabel: function () {
      return (this._matchedEntry && this._matchedEntry.label) ||
             location.hostname;
    },

    pairs: function () {
      // Collect ALL h1/h2/h3 from the live page DOM, excluding the widget.
      var allHeadings = Array.from(
        document.body.querySelectorAll('h1, h2, h3')
      ).filter(function (el) {
        return !el.closest('#tocic-root') &&
               (el.innerText || el.textContent || '').trim().length > 0;
      });

      if (allHeadings.length === 0) return [];

      // Determine minimum level present for promotion (same logic as extractHeadings).
      // e.g. if only h2/h3 exist, h2 becomes the "top level".
      var minLevel = allHeadings.reduce(function (m, h) {
        return Math.min(m, parseInt(h.tagName[1], 10));
      }, 4);

      var topLevelEls = allHeadings.filter(function (h) {
        return parseInt(h.tagName[1], 10) === minLevel;
      });

      return topLevelEls.map(function (hEl, i) {
        var text = (hEl.innerText || hEl.textContent || '').trim();

        // Collect the live sub-headings (level > minLevel) that belong to
        // this section — i.e. those that appear after hEl and before the
        // next top-level heading in the allHeadings list.
        var hElIdx       = allHeadings.indexOf(hEl);
        var nextTopElIdx = topLevelEls[i + 1]
          ? allHeadings.indexOf(topLevelEls[i + 1])
          : allHeadings.length;

        var subHeadings = allHeadings.slice(hElIdx + 1, nextTopElIdx)
          .filter(function (h) {
            return parseInt(h.tagName[1], 10) > minLevel;
          });

        // Build a lightweight proxy object that satisfies extractHeadings(botEl):
        // it only needs to support querySelectorAll('h1,h2,h3'), which we fake
        // by attaching the live sub-heading elements directly.
        // We attach the list as a custom property and override pairs() result
        // by setting botEl._subHeadings so content.js can detect this mode.
        var botProxy = null;
        if (subHeadings.length > 0) {
          botProxy = {
            _isDocSection: true,
            _subHeadings:  subHeadings,
            // querySelectorAll shim used by extractHeadings()
            querySelectorAll: function () { return subHeadings; }
          };
        }

        return {
          userEl: hEl,
          botEl:  botProxy,
          text:   text
        };
      });
    }
  };

  // ── Export ──────────────────────────────────────────────────────────────────
  global.TocicAdapters = [
    grokComAdapter,
    claudeAdapter,
    chatgptAdapter,
    customUrlAdapter   // checked last so named adapters take priority
  ];

})(window);
