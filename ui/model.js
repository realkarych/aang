(function (root) {
  "use strict";

  var CELLS = [
    { key: "inbox", title: "Входящее", sub: "предложения агента и вопросы, которых вы ещё не видели" },
    { key: "research", title: "Ресерч", sub: "под вопросом: нужно исследовать" },
    { key: "discuss", title: "Обсудить", sub: "под вопросом: нужно обсудить" },
    { key: "confirmed", title: "Подтверждено", sub: "принято — вами или агентом" },
    { key: "rejected", title: "Отвергнуто", sub: "остаётся в записи, чтобы не предлагать снова" },
    { key: "tacit", title: "Неявные решения", sub: "приняты без того, чтобы кто-то выбирал" },
    { key: "orphaned", title: "Осиротело решениями", sub: "вопросы, которые повисли из-за принятого решения" },
    { key: "hanging", title: "Просто висит", sub: "к этому не вернулись; какое решение виновато — не названо" },
    { key: "decisions", title: "Решения", sub: "заменённые и предложенные вами" }
  ];
  var LANES = ["tacit", "open", "decision"];
  var SUPERSEDED_GAP = 60;

  var BLOCKS = [
    { key: "decided", title: "Решено", sub: "в силе — выбрано или принято молча" },
    { key: "open", title: "Под вопросом", sub: "ждёт вас: предложено агентом, спрошено, отложено" },
    { key: "rejected", title: "Отвергнуто", sub: "остаётся в записи, чтобы не предлагать снова" }
  ];
  var NAME_WORDS = 3;
  var SPACE_RUN = /[\u0009-\u000d\u001c-\u001f\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/;
  var EDGE_LABELS = { rests_on: "держится на", orphaned_by: "осиротело", moots: "обесценило", superseded_by: "заменено на" };

  function emptyMap() {
    return Object.create(null);
  }

  function blockOf(n) {
    if (n.status === "rejected") return "rejected";
    if (n.status === "superseded") return null;
    if (n.kind === "open" || n.status === "proposed" || n.triage) return "open";
    return "decided";
  }

  function lineOf(n) {
    var text = (n.kind === "open" ? n.question : n.decision) || "";
    if (n.triage === "research") return { glyph: "?", verb: "изучить", text: text };
    if (n.triage === "discuss") return { glyph: "?", verb: "обсудить", text: text };
    if (n.status === "rejected") return { glyph: "✖", verb: "отвергнуто", text: text };
    if (n.status === "superseded") return { glyph: "●", verb: "заменено", text: text };
    if (n.kind === "open") return { glyph: "○", verb: "открыто", text: text };
    if (n.kind === "tacit") return { glyph: "◌", verb: "молча", text: text };
    if (n.status === "proposed") {
      if (n.decided_by === "agent") return { glyph: "◆", verb: "агент сам", text: text };
      return { glyph: "◇", verb: "предложено", text: text };
    }
    return { glyph: "●", verb: "решили", text: text };
  }

  function collapse(name) {
    return String(name).split(SPACE_RUN).filter(Boolean).join(" ");
  }

  function topicKey(name) {
    if (typeof name !== "string") return "";
    return collapse(name).toLowerCase();
  }

  function targetsOf(n) {
    var out = (n.relates || []).map(function (r) { return r && r.to; });
    out.push(n.superseded_by);
    return out.filter(function (t) { return typeof t === "string" && t; });
  }

  function fallbackName(n) {
    var words = String(n.question || "").split(SPACE_RUN).filter(Boolean);
    if (!words.length) return String(n.id || "");
    var name = words.slice(0, NAME_WORDS).join(" ");
    return words.length > NAME_WORDS ? name + "…" : name;
  }

  function topicsOf(input) {
    var nodes = (input || []).filter(function (n) {
      return !!n && typeof n === "object" && typeof n.id === "string" && !!n.id;
    });
    var index = emptyMap(), byId = emptyMap(), parent = emptyMap();
    nodes.forEach(function (n, i) { index[n.id] = i; byId[n.id] = n; parent[n.id] = n.id; });

    function find(x) {
      while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
      return x;
    }

    nodes.forEach(function (n) {
      targetsOf(n).forEach(function (target) {
        if (!(target in parent)) return;
        var a = find(n.id), b = find(target);
        if (a === b) return;
        if (index[a] < index[b]) parent[b] = a; else parent[a] = b;
      });
    });
    var members = emptyMap(), roots = [];
    nodes.forEach(function (n) {
      var root = find(n.id);
      if (!members[root]) { members[root] = []; roots.push(root); }
      members[root].push(n.id);
    });
    var keyed = emptyMap(), lentNames = emptyMap(), order = [];
    roots.sort(function (a, b) { return index[a] - index[b]; }).forEach(function (root) {
      var ids = members[root];
      var named = ids.filter(function (i) { return topicKey(byId[i].topic); });
      var lent = named.length ? byId[named[0]].topic : fallbackName(byId[ids[0]]);
      if (!named.length && !(topicKey(lent) in lentNames)) lentNames[topicKey(lent)] = collapse(lent);
      ids.forEach(function (i) {
        var own = byId[i].topic;
        var key = topicKey(topicKey(own) ? own : lent);
        if (!keyed[key]) { keyed[key] = []; order.push(key); }
        keyed[key].push(i);
      });
    });
    var out = order.map(function (key) {
      var ids = keyed[key].sort(function (a, b) { return index[a] - index[b]; });
      var spelled = ids.filter(function (i) { return topicKey(byId[i].topic); });
      return { name: spelled.length ? collapse(byId[spelled[0]].topic) : lentNames[key], ids: ids };
    });

    function rank(group) {
      var added = "", pos = -1;
      group.ids.forEach(function (i) {
        var at = String(byId[i].added_at || "");
        if (at > added) added = at;
        if (index[i] > pos) pos = index[i];
      });
      return { added: added, pos: pos };
    }

    out.sort(function (a, b) {
      var ra = rank(a), rb = rank(b);
      if (ra.added !== rb.added) return ra.added > rb.added ? -1 : 1;
      return rb.pos - ra.pos;
    });
    return out;
  }

  function isNew(n, since) {
    return !!since && !!n.added_at && n.added_at > since;
  }

  function clipText(s, limit) {
    s = String(s || "");
    return s.length > limit ? s.slice(0, limit - 1) + "…" : s;
  }

  function topicLayout(nodes, width, opts) {
    opts = opts || {};
    var charW = opts.charW || 7, pad = opts.pad || 10, boxH = opts.boxH || 26, gapX = opts.gapX || 10,
        gapY = opts.gapY || 12, laneHead = opts.laneHead || 24, laneFoot = opts.laneFoot || 12,
        maxChars = opts.maxChars || 40, margin = opts.margin || 8;
    var ids = emptyMap();
    nodes.forEach(function (n) { ids[n.id] = true; });
    var outside = emptyMap();
    nodes.forEach(function (n) {
      targetsOf(n).forEach(function (t) { if (!ids[t]) outside[n.id] = (outside[n.id] || 0) + 1; });
      (n.related_by || []).forEach(function (r) { if (r && !ids[r.from]) outside[n.id] = (outside[n.id] || 0) + 1; });
    });
    var lanes = [], boxes = [], byId = emptyMap(), y = 0;
    BLOCKS.forEach(function (b) {
      var members = nodes.filter(function (n) { return (blockOf(n) || "decided") === b.key; });
      var x = margin, row = 0, top = y + laneHead;
      members.forEach(function (n) {
        var l = lineOf(n);
        var label = clipText(l.glyph + " " + l.text, maxChars) + (outside[n.id] ? " +" + outside[n.id] : "");
        var w = Math.min(width - 2 * margin, pad * 2 + label.length * charW);
        if (x + w > width - margin && x > margin) { x = margin; row += 1; }
        var box = { id: n.id, label: label, struck: n.status === "superseded", lane: b.key,
                    x: x, y: top + row * (boxH + gapY), w: w, h: boxH };
        boxes.push(box);
        byId[n.id] = box;
        x += w + gapX;
      });
      var height = laneHead + (members.length ? (row + 1) * (boxH + gapY) : boxH) + laneFoot;
      lanes.push({ key: b.key, title: b.title, y: y, height: height, count: members.length });
      y += height;
    });
    var edges = [];
    nodes.forEach(function (n) {
      var from = byId[n.id];
      var rels = (n.relates || []).filter(Boolean).map(function (r) { return { to: r.to, rel: r.rel }; });
      if (n.superseded_by) rels.push({ to: n.superseded_by, rel: "superseded_by" });
      rels.forEach(function (r) {
        var to = byId[r.to];
        if (!to) return;
        edges.push({ from: n.id, to: r.to, rel: r.rel, label: EDGE_LABELS[r.rel] || r.rel,
                     x1: from.x + from.w / 2, y1: from.y + from.h / 2,
                     x2: to.x + to.w / 2, y2: to.y + to.h / 2 });
      });
    });
    return { width: width, height: y, lanes: lanes, boxes: boxes, edges: edges, outside: outside };
  }

  function hasRel(n, rel) {
    return (n.relates || []).some(function (r) { return !!r && r.rel === rel; });
  }

  function isUnseen(n) {
    var seen = n.seen_at || "", added = n.added_at || "";
    if (!seen) return true;
    return !!added && seen < added;
  }

  function cellOf(n) {
    if (n.status === "rejected") return "rejected";
    if (n.triage === "research") return "research";
    if (n.triage === "discuss") return "discuss";
    if (n.kind === "decision" && n.status === "accepted") return "confirmed";
    if (n.kind === "decision" && n.status === "proposed" && n.decided_by === "agent") return "inbox";
    if (n.kind === "open" && isUnseen(n)) return "inbox";
    if (n.kind === "tacit") return "tacit";
    if (n.kind === "open") return hasRel(n, "orphaned_by") ? "orphaned" : "hanging";
    return "decisions";
  }

  function authorOf(n) {
    if (n.kind !== "decision") return null;
    return n.decided_by === "user" || n.decided_by === "agent" ? n.decided_by : "unknown";
  }

  function firstTurn(n) {
    var best = null;
    (n.cites || []).forEach(function (c) {
      if (c && c.ok === true && typeof c.turn === "number" && (best === null || c.turn < best)) best = c.turn;
    });
    return best;
  }

  function verdictButtons(n) {
    if (n.status === "superseded") return [];
    if (n.status === "rejected") return ["confirmed"];
    if (n.kind === "decision" && n.status === "accepted") return ["research", "discuss", "rejected"];
    return ["confirmed", "research", "discuss", "rejected"];
  }

  function timelineLayout(map, opts) {
    var px = opts.pxPerTurn, laneHeight = opts.laneHeight, gutter = opts.gutter, step = opts.stepDown;
    var coverage = map.coverage || {};
    var turns = coverage.turns || 0;
    var lanes = LANES.map(function (kind, i) { return { kind: kind, y: laneHeight * i + laneHeight / 2 }; });
    var laneY = {};
    lanes.forEach(function (lane) { laneY[lane.kind] = lane.y; });
    var stacked = {};
    var marks = (map.nodes || []).map(function (n) {
      var turn = firstTurn(n);
      var kind = laneY.hasOwnProperty(n.kind) ? n.kind : "decision";
      var slot = kind + ":" + (turn === null ? "-" : turn);
      var stack = stacked[slot] || 0;
      stacked[slot] = stack + 1;
      if (turn !== null && turn > turns) turns = turn;
      return {
        id: n.id, kind: kind, turn: turn, noTurn: turn === null,
        x: turn === null ? gutter / 2 : gutter + (turn - 1) * px,
        y: laneY[kind] + stack * step,
        cell: cellOf(n), author: authorOf(n), unseen: isUnseen(n),
        superseded: n.status === "superseded", rejected: n.status === "rejected"
      };
    });
    return {
      width: gutter + turns * px, height: laneHeight * LANES.length, lanes: lanes, marks: marks,
      coverage: typeof coverage.covered_to === "number" ? { x: gutter + coverage.covered_to * px } : null
    };
  }

  function trimToFit(columns, keep) {
    var i = 0;
    while (countSlots(columns) > keep) {
      var column = columns[i % columns.length];
      i += 1;
      if (column.length) column.pop();
    }
  }

  function countSlots(columns) {
    return columns.reduce(function (total, column) { return total + column.length; }, 0);
  }

  function spreadDown(column, x, height) {
    column.forEach(function (slot, i) {
      slot.x = x;
      slot.y = height * (i + 1) / (column.length + 1);
    });
  }

  function spreadAcross(column, y, width) {
    column.forEach(function (slot, i) {
      slot.x = width / 2 + (i - (column.length - 1) / 2) * SUPERSEDED_GAP;
      slot.y = y;
    });
  }

  function neighbourhoodLayout(n, map, opts) {
    var width = opts.width, height = opts.height, max = opts.max;
    var left = (n.relates || []).map(function (r) { return { id: r.to, rel: r.rel }; });
    var right = (n.related_by || []).map(function (r) { return { id: r.from, rel: r.rel }; });
    var top = n.superseded_by ? [{ id: n.superseded_by, rel: "superseded_by" }] : [];
    var bottom = (map.nodes || [])
      .filter(function (m) { return m.id !== n.id && m.superseded_by === n.id; })
      .map(function (m) { return { id: m.id, rel: "superseded_by" }; });
    var columns = [left, right, top, bottom];
    var overflow = 0;
    if (countSlots(columns) > max) {
      overflow = countSlots(columns) - (max - 1);
      trimToFit(columns, max - 1);
      right.push({ id: "+" + overflow, rel: "", overflow: overflow });
    }
    spreadDown(left, width * 0.15, height);
    spreadDown(right, width * 0.85, height);
    spreadAcross(top, height * 0.12, width);
    spreadAcross(bottom, height * 0.88, width);
    return {
      center: { id: n.id, x: width / 2, y: height / 2 },
      left: left, right: right, top: top, bottom: bottom, overflow: overflow
    };
  }

  var api = {
    CELLS: CELLS, LANES: LANES, hasRel: hasRel, isUnseen: isUnseen, cellOf: cellOf, authorOf: authorOf,
    firstTurn: firstTurn, verdictButtons: verdictButtons, timelineLayout: timelineLayout,
    neighbourhoodLayout: neighbourhoodLayout,
    BLOCKS: BLOCKS, EDGE_LABELS: EDGE_LABELS, blockOf: blockOf, lineOf: lineOf, topicKey: topicKey,
    topicsOf: topicsOf, isNew: isNew, topicLayout: topicLayout
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AangModel = api;
})(typeof window !== "undefined" ? window : this);
