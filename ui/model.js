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
    neighbourhoodLayout: neighbourhoodLayout
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AangModel = api;
})(typeof window !== "undefined" ? window : this);
