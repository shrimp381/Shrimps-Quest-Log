const MODULE_ID = "shrimps-quest-log";
const SC_MODULE_ID = "segmented-cycle";
const SIMPLE_CALENDAR_MODULE_ID = "foundryvtt-simple-calendar";
const SOCKET_NAME = `module.${MODULE_ID}`;
const SEGMENT_BARS = ["day", "night", "custom"];
const SEGMENT_BAR_LABELS = { day: "Day", night: "Night", custom: "Custom" };

/* =========================================================================
   Pure date helpers. All operate on a plain { yearLabel, months:[{name,days}] }
   calendar object and { year, monthIndex, day } date objects, so none of
   this depends on Foundry being loaded and it is easy to reason about.
   ========================================================================= */

function ordinalSuffix(n) {
  const j = n % 10;
  const k = n % 100;
  if (j === 1 && k !== 11) return "st";
  if (j === 2 && k !== 12) return "nd";
  if (j === 3 && k !== 13) return "rd";
  return "th";
}

function formatDate(calendar, dateObj) {
  const months = calendar.months;
  const month = months[dateObj.monthIndex] || months[0];
  return `${dateObj.day}${ordinalSuffix(dateObj.day)} of ${month.name}, ${dateObj.year} ${calendar.yearLabel}`;
}

function dateKey(d) {
  return `${d.year}-${d.monthIndex}-${d.day}`;
}

function sameDate(a, b) {
  return !!a && !!b && a.year === b.year && a.monthIndex === b.monthIndex && a.day === b.day;
}

function addDays(calendar, dateObj, delta) {
  const months = calendar.months;
  let { year, monthIndex, day } = dateObj;
  day += delta;
  if (delta >= 0) {
    while (day > months[monthIndex].days) {
      day -= months[monthIndex].days;
      monthIndex++;
      if (monthIndex >= months.length) { monthIndex = 0; year++; }
    }
  } else {
    while (day < 1) {
      monthIndex--;
      if (monthIndex < 0) { monthIndex = months.length - 1; year--; }
      day += months[monthIndex].days;
    }
  }
  return { year, monthIndex, day };
}

function shiftMonth(calendar, monthState, delta) {
  const months = calendar.months;
  let { year, monthIndex } = monthState;
  monthIndex += delta;
  if (monthIndex >= months.length) { monthIndex = 0; year++; }
  if (monthIndex < 0) { monthIndex = months.length - 1; year--; }
  return { year, monthIndex };
}

function clampDateToCalendar(calendar, dateObj) {
  const monthIndex = Math.min(dateObj.monthIndex, calendar.months.length - 1);
  const day = Math.min(dateObj.day, calendar.months[monthIndex].days);
  return { ...dateObj, monthIndex, day };
}

/* =========================================================================
   Default data shape, stored whole in a single world setting. Keeping one
   JSON blob (rather than many settings) makes it easy to keep everything
   consistent and to sync to players purely through Foundry's normal
   setting broadcast.
   ========================================================================= */

function defaultData() {
  return {
    nextQuestId: 100,
    nextNoteId: 100,
    nextTabId: 1,
    nextEventId: 100,
    showCalendarSection: true,
    showSegmentSection: true,
    useSimpleCalendar: true,
    calendar: {
      yearLabel: "AE",
      months: [
        { name: "Frostmere", days: 30 },
        { name: "Harrowmoon", days: 30 },
        { name: "Emberfall", days: 30 },
        { name: "Suncrest", days: 30 },
      ],
    },
    currentDateObj: { year: 812, monthIndex: 1, day: 9 },
    calendarEvents: {},
    segmentBarPrevFilled: { day: 0, night: 0, custom: 0 },
    tabs: {
      main: { label: "Main Quest", categories: [], quests: [] },
      side: { label: "Side Quest", categories: [], quests: [] },
      rumours: { label: "Rumours", categories: [], quests: [] },
    },
  };
}

function registerSettings() {
  game.settings.register(MODULE_ID, "data", {
    scope: "world",
    config: false,
    type: Object,
    default: defaultData(),
  });
}

function loadQuestData() {
  const data = game.settings.get(MODULE_ID, "data");
  if (!data || !data.tabs) return defaultData();
  // Defensive defaults for anyone upgrading from an earlier shape.
  data.showCalendarSection ??= true;
  data.showSegmentSection ??= true;
  data.useSimpleCalendar ??= true;
  data.calendarEvents ??= {};
  data.segmentBarPrevFilled ??= { day: 0, night: 0, custom: 0 };
  return data;
}

async function saveQuestData(data) {
  if (!game.user.isGM) return;
  await game.settings.set(MODULE_ID, "data", data);
}

/* =========================================================================
   Optional integrations. Both are best effort: Simple Calendar and
   Segmented Cycle are read through their public settings/API rather than
   a tight dependency, so Quest Log stays fully usable without either.
   ========================================================================= */

function isSimpleCalendarActive() {
  return !!(game.modules.get(SIMPLE_CALENDAR_MODULE_ID)?.active && window.SimpleCalendar?.api);
}

function simpleCalendarDateLabel() {
  try {
    const display = window.SimpleCalendar.api.currentDateTimeDisplay();
    return display?.date || null;
  } catch (err) {
    console.warn(`${MODULE_ID} | Could not read the date from Simple Calendar`, err);
    return null;
  }
}

function currentDateLabel(data) {
  if (data.useSimpleCalendar && isSimpleCalendarActive()) {
    const label = simpleCalendarDateLabel();
    if (label) return label;
  }
  return formatDate(data.calendar, data.currentDateObj);
}

function isSegmentedCycleActive() {
  return !!game.modules.get(SC_MODULE_ID)?.active;
}

// Called whenever one of Segmented Cycle's *Filled settings changes. Any
// quest with its Segment Cycle integration enabled and pointed at that bar
// has its ticked count advanced by however much the bar just filled, up to
// its own allocation, mirroring the "automatically tick the segment
// forward" behaviour from the original spec.
async function applySegmentTick(bar, newFilled) {
  if (!game.user.isGM || !SEGMENT_BARS.includes(bar)) return;
  const data = loadQuestData();
  const prev = data.segmentBarPrevFilled[bar] ?? 0;
  const delta = newFilled - prev;
  data.segmentBarPrevFilled[bar] = newFilled;

  if (delta > 0) {
    for (const tabKey of Object.keys(data.tabs)) {
      for (const q of data.tabs[tabKey].quests) {
        if (q.segment?.enabled && q.segment.bar === bar && q.status === "active") {
          q.segment.ticked = Math.min(q.segment.allocated, q.segment.ticked + delta);
        }
      }
    }
  }
  await saveQuestData(data);
}

/* =========================================================================
   Cross client actions. World settings can only be written by a GM, so the
   one action a player can trigger (adding a party note) is relayed to a
   connected GM's client over a socket, which applies it and saves as
   normal; the resulting setting update then reaches everyone, including
   the player who asked for it. This mirrors how most Foundry modules
   handle player writes to shared world data, and it does mean a GM needs
   to be online for a player's note to land.
   ========================================================================= */

async function addPlayerNoteLocal(questId, author, text) {
  const data = loadQuestData();
  const loc = findQuestLocation(data, questId);
  if (!loc) return;
  const quest = data.tabs[loc.tabKey].quests[loc.idx];
  const clean = (text || "").trim();
  if (!clean) return;
  quest.playerNotes.push({ id: `p${data.nextNoteId++}`, author, text: clean, date: currentDateLabel(data) });
  await saveQuestData(data);
}

function requestAddPlayerNote(questId, text) {
  if (game.user.isGM) {
    addPlayerNoteLocal(questId, game.user.name, text);
    return;
  }
  game.socket.emit(SOCKET_NAME, { action: "addPlayerNote", questId, text, author: game.user.name });
}

function onSocketMessage(msg) {
  if (!game.user.isGM || !msg) return;
  if (msg.action === "addPlayerNote") {
    addPlayerNoteLocal(msg.questId, msg.author, msg.text);
  }
}

/* =========================================================================
   Shared lookups used by both the app and the socket handler.
   ========================================================================= */

function findQuestLocation(data, id) {
  for (const tabKey of Object.keys(data.tabs)) {
    const idx = data.tabs[tabKey].quests.findIndex((q) => q.id === id);
    if (idx !== -1) return { tabKey, idx };
  }
  return null;
}

function getQuestsLinkedToDate(data, d) {
  const results = [];
  for (const tabKey of Object.keys(data.tabs)) {
    const tab = data.tabs[tabKey];
    for (const q of tab.quests) {
      if (q.linkedDate && sameDate(q.linkedDate, d)) {
        results.push({ questId: q.id, title: q.title, tabLabel: tab.label });
      }
    }
  }
  return results;
}

function buildDayCells(data, year, monthIndex, selectedKey) {
  const months = data.calendar.months;
  const month = months[monthIndex] || months[0];
  const cells = [];
  for (let day = 1; day <= month.days; day++) {
    const d = { year, monthIndex, day };
    const key = dateKey(d);
    const isToday = sameDate(d, data.currentDateObj);
    const isSelected = selectedKey === key;
    const events = data.calendarEvents[key] || [];
    const linked = getQuestsLinkedToDate(data, d);
    const hasMarks = events.length > 0 || linked.length > 0;
    cells.push({
      day,
      key,
      year,
      monthIndex,
      hasMarks,
      style: `position:relative; display:flex; align-items:center; justify-content:center; aspect-ratio:1; min-height:26px; border-radius:6px; border:1px solid ${isToday ? "#C9A227" : "rgba(255,255,255,0.12)"}; background:${isSelected ? "rgba(201,162,39,0.28)" : "rgba(255,255,255,0.03)"}; color:${isToday ? "#e8c96a" : "#cfc6b0"}; font-size:11px; cursor:pointer; font-weight:${isToday ? "700" : "400"};`,
    });
  }
  return cells;
}

function buildMonthOptions(months, selectedIdx) {
  return months.map((m, i) => ({ value: i, label: m.name, selected: i === selectedIdx }));
}

function buildDayOptions(maxDay, selectedDay) {
  const opts = [];
  for (let d = 1; d <= maxDay; d++) opts.push({ value: d, selected: d === selectedDay });
  return opts;
}

function buildSegmentPips(segment) {
  const gap = 3;
  const trackWidth = 110;
  const pipW = Math.max(5, Math.min(14, Math.floor((trackWidth - (segment.allocated - 1) * gap) / segment.allocated)));
  const pips = [];
  for (let i = 0; i < segment.allocated; i++) {
    const filled = i < segment.ticked;
    pips.push({ style: `width:${pipW}px; height:12px; border-radius:3px; background:${filled ? "#C9A227" : "transparent"}; border:1px solid #C9A227;` });
  }
  return pips;
}

/* =========================================================================
   The application itself. Persistent data (quests, tabs, calendar, events)
   lives in the world setting above; everything here on the instance is
   purely local UI state (which tab is showing, what's mid-edit, which
   popover is open) so re-rendering never has to round trip the network.
   ========================================================================= */

class QuestLogApp extends Application {
  constructor(options) {
    super(options);
    this.activeTab = "main";
    this.activeCategory = {};
    this.expandedId = null;

    this.showAddForm = false;
    this.draft = { title: "", tab: "main", category: "", summary: "" };

    this.showCatInput = false;
    this.catDraft = "";

    this.editingTabKey = null;
    this.tabNameDraft = "";
    this.showAddTabInput = false;
    this.newTabDraft = "";

    this.configOpen = false;

    this.calendarPanelOpen = true;
    this.calendarViewMonth = null;
    this.selectedCalendarDay = null;
    this.calendarEventDraft = "";

    this.showJumpPicker = false;
    this.jumpView = null;

    this.questDatePicker = { questId: null, year: 0, monthIndex: 0, day: 1 };

    this._updateDrafts = {};
    this._noteDrafts = {};
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "shrimps-quest-log-app",
      title: game.i18n?.localize("QUESTLOG.Title") ?? "Shrimps Quest Log",
      template: `modules/${MODULE_ID}/templates/quest-log.hbs`,
      width: 900,
      height: 760,
      resizable: true,
      classes: ["quest-log-app"],
    });
  }

  /* ---------------- data assembly ---------------- */

  getData() {
    const data = loadQuestData();
    const isGm = game.user.isGM;
    const calendar = data.calendar;

    if (!this.calendarViewMonth) this.calendarViewMonth = { year: data.currentDateObj.year, monthIndex: data.currentDateObj.monthIndex };
    if (!this.jumpView) this.jumpView = { year: data.currentDateObj.year, monthIndex: data.currentDateObj.monthIndex };

    const scSynced = !!(data.useSimpleCalendar && isSimpleCalendarActive());
    const segmentModuleActive = isSegmentedCycleActive();
    const effectiveShowSegmentSection = data.showSegmentSection && segmentModuleActive;

    const activeTab = this.activeTab;
    const isFinished = activeTab === "finished";
    const activeCat = this.activeCategory[activeTab] || "all";

    const realTabOrder = Object.keys(data.tabs);
    const finishedCount = this._getFinishedEntries(data).length;
    const tabOrder = [...realTabOrder, "finished"];
    const canDeleteTab = realTabOrder.length > 1;
    const tabButtons = tabOrder.map((key) => {
      const active = key === activeTab;
      const label = key === "finished" ? "Finished" : data.tabs[key].label;
      const count = key === "finished" ? finishedCount : data.tabs[key].quests.filter((q) => q.status === "active").length;
      return {
        key,
        label,
        count,
        active,
        style: `background:${active ? "rgba(201,162,39,0.14)" : "transparent"}; color:${active ? "#e8c96a" : "#a89e88"}; border:none; border-bottom:2px solid ${active ? "#C9A227" : "transparent"}; padding:10px 18px; font-size:14px; font-weight:600; cursor:pointer; border-radius:6px 6px 0 0;`,
        canManage: isGm && key !== "finished" && canDeleteTab,
        isEditing: this.editingTabKey === key,
        nameDraft: this.editingTabKey === key ? this.tabNameDraft : "",
      };
    });

    let questCards;
    let categorySource;

    if (isFinished) {
      const entries = this._getFinishedEntries(data);
      categorySource = [...new Set(entries.map((e) => e.quest.category))].sort();
      const filtered = activeCat === "all" ? entries : entries.filter((e) => e.quest.category === activeCat);
      questCards = filtered.map((e) => this._makeQuestCard(data, e.quest, this.expandedId === e.quest.id, e.originLabel, isGm, effectiveShowSegmentSection, scSynced));
    } else {
      const tab = data.tabs[activeTab] || data.tabs[realTabOrder[0]];
      categorySource = tab.categories;
      const activeQuests = tab.quests.filter((q) => q.status === "active");
      const filtered = activeCat === "all" ? activeQuests : activeQuests.filter((q) => q.category === activeCat);
      questCards = filtered.map((q) => this._makeQuestCard(data, q, this.expandedId === q.id, null, isGm, effectiveShowSegmentSection, scSynced));
    }

    const categoryChips = [{ key: "all", label: "All", active: activeCat === "all" }, ...categorySource.map((c) => ({ key: c, label: c, active: activeCat === c }))].map((chip) => ({
      ...chip,
      style: `background:${chip.active ? "rgba(201,162,39,0.2)" : "rgba(255,255,255,0.05)"}; color:${chip.active ? "#e8c96a" : "#a89e88"}; border:1px solid ${chip.active ? "rgba(201,162,39,0.5)" : "rgba(255,255,255,0.14)"}; border-radius:20px; padding:6px 14px; font-size:12px; cursor:pointer;`,
      canDelete: isGm && !isFinished && chip.key !== "all",
    }));

    const sectionOptions = realTabOrder.map((key) => ({ key, label: data.tabs[key].label }));
    const monthOptions = buildMonthOptions(calendar.months, -1);

    const monthRows = calendar.months.map((m, i) => ({ idx: i, name: m.name, days: m.days, canDelete: calendar.months.length > 1 }));

    const jumpMonth = calendar.months[this.jumpView.monthIndex] || calendar.months[0];
    const jumpMonthLabel = `${jumpMonth.name}, ${this.jumpView.year} ${calendar.yearLabel}`;
    const jumpCells = buildDayCells(data, this.jumpView.year, this.jumpView.monthIndex, null);

    const calMonth = calendar.months[this.calendarViewMonth.monthIndex] || calendar.months[0];
    const calendarMonthLabel = `${calMonth.name}, ${this.calendarViewMonth.year} ${calendar.yearLabel}`;
    const calendarCells = buildDayCells(data, this.calendarViewMonth.year, this.calendarViewMonth.monthIndex, this.selectedCalendarDay);

    let selectedCalendarDayLabel = "";
    let selectedCalendarEvents = [];
    let selectedLinkedQuests = [];
    if (this.selectedCalendarDay) {
      const parts = this.selectedCalendarDay.split("-").map((n) => parseInt(n, 10));
      const selDate = { year: parts[0], monthIndex: parts[1], day: parts[2] };
      selectedCalendarDayLabel = formatDate(calendar, selDate);
      selectedCalendarEvents = data.calendarEvents[this.selectedCalendarDay] || [];
      selectedLinkedQuests = getQuestsLinkedToDate(data, selDate);
    }

    return {
      isGm,
      currentDate: currentDateLabel(data),
      scActive: isSimpleCalendarActive(),
      scSynced,
      useSimpleCalendar: data.useSimpleCalendar,

      showCalendarSection: data.showCalendarSection,
      segmentModuleActive,
      showSegmentSection: data.showSegmentSection,
      effectiveShowSegmentSection,

      configOpen: this.configOpen,
      calendarYearLabel: calendar.yearLabel,
      monthRows,
      monthOptions,

      showJumpPicker: this.showJumpPicker,
      jumpMonthLabel,
      jumpCells,

      calendarPanelOpen: this.calendarPanelOpen,
      calendarToggleIcon: this.calendarPanelOpen ? "▾" : "▸",
      calendarHeaderRadius: this.calendarPanelOpen ? "10px 10px 0 0" : "10px",
      calendarMonthLabel,
      calendarCells,
      hasSelectedCalendarDay: !!this.selectedCalendarDay,
      selectedCalendarDay: this.selectedCalendarDay,
      selectedCalendarDayLabel,
      selectedCalendarEvents,
      hasSelectedLinkedQuests: selectedLinkedQuests.length > 0,
      selectedLinkedQuests,
      calendarEventDraft: this.calendarEventDraft,

      tabButtons,
      showTabAdmin: isGm,
      showAddTabInput: this.showAddTabInput,
      newTabDraft: this.newTabDraft,

      categoryChips,
      showCategoryAdmin: isGm && !isFinished,
      showCatInput: this.showCatInput,
      catDraft: this.catDraft,

      showAddForm: this.showAddForm,
      draft: this.draft,
      sectionOptions,
      draftCategoryOptions: data.tabs[this.draft.tab] ? data.tabs[this.draft.tab].categories : [],

      questCards,
      noQuests: questCards.length === 0,
    };
  }

  _getFinishedEntries(data) {
    const entries = [];
    for (const key of Object.keys(data.tabs)) {
      const tab = data.tabs[key];
      for (const q of tab.quests) {
        if (q.status !== "active") entries.push({ quest: q, originLabel: tab.label });
      }
    }
    return entries;
  }

  _makeQuestCard(data, q, isExpanded, originLabel, isGm, effectiveShowSegmentSection, scSynced) {
    const finished = q.status !== "active";
    const statusColor = q.status === "active" ? "#C9A227" : q.status === "completed" ? "#5a9c6a" : "#8B0000";
    const titleStyle = finished
      ? `color:${statusColor}; text-decoration:line-through; text-decoration-thickness:2px; opacity:0.75;`
      : "color:#f0e9d8;";

    const revealedNotes = q.updates.filter((n) => n.revealed);
    const updates = q.updates.map((n) => ({
      ...n,
      textStyle: n.revealed ? "color:#c9a227;" : "color:#d8cdbb;",
      metaLine: n.revealed ? `Written ${n.dateWritten} · revealed to players ${n.dateRevealed}` : `Written ${n.dateWritten} · not yet revealed`,
      revealLabel: n.revealed ? "Revealed" : "Reveal",
      revealBtnStyle: n.revealed
        ? "background:rgba(201,162,39,0.25); color:#e8c96a; border:1px solid rgba(201,162,39,0.5); border-radius:6px; padding:3px 8px; font-size:10px; cursor:pointer; white-space:nowrap;"
        : "background:rgba(255,255,255,0.06); color:#a89e88; border:1px solid rgba(255,255,255,0.16); border-radius:6px; padding:3px 8px; font-size:10px; cursor:pointer; white-space:nowrap;",
    }));

    const playerNotes = q.playerNotes.map((n) => ({ ...n, canDelete: isGm }));

    const hasLinkedDate = !!q.linkedDate;
    const linkedDateFull = hasLinkedDate ? formatDate(data.calendar, q.linkedDate) : "";

    const dp = this.questDatePicker;
    const showDatePicker = dp.questId === q.id;
    let datePicker = null;
    if (showDatePicker) {
      const months = data.calendar.months;
      const pickMonth = months[dp.monthIndex] || months[0];
      datePicker = {
        year: dp.year,
        monthOptions: buildMonthOptions(months, dp.monthIndex),
        dayOptions: buildDayOptions(pickMonth.days, dp.day),
      };
    }

    return {
      id: q.id,
      title: q.title,
      titleStyle,
      category: q.category,
      showOrigin: !!originLabel,
      originLabel: originLabel || "",
      status: q.status,
      summary: q.summary,
      dateLogged: q.dateLogged,
      isExpanded,
      chevron: isExpanded ? "▾" : "▸",
      cardStyle: `background:rgba(255,255,255,0.035); border:1px solid rgba(255,255,255,0.1); border-left:3px solid ${statusColor}; border-radius:10px; overflow:hidden;`,
      dotStyle: `width:9px; height:9px; border-radius:50%; background:${statusColor}; flex:0 0 auto;`,

      showSegmentChip: isGm && q.segment.enabled && effectiveShowSegmentSection,
      segmentSummary: `${q.segment.ticked}/${q.segment.allocated} (${SEGMENT_BAR_LABELS[q.segment.bar] || "Day"})`,

      showLinkedChip: hasLinkedDate && data.showCalendarSection,
      linkedDateLabel: hasLinkedDate ? formatDate(data.calendar, q.linkedDate) : "",

      showGmSection: isGm,
      updatesHint: q.updates.length ? `(${q.updates.length})` : "",
      updates,
      updateDraft: this._updateDrafts[q.id] || "",

      showRevealedOnly: !isGm && revealedNotes.length > 0,
      revealedNotes,

      hasPlayerNotes: q.playerNotes.length > 0,
      playerNotes,
      noteDraft: this._noteDrafts[q.id] || "",

      showCalendarLink: isGm && data.showCalendarSection,
      scDateNote: scSynced,
      hasLinkedDate,
      linkedDateFull,
      showDatePicker,
      datePicker,

      showSegmentPanel: isGm && effectiveShowSegmentSection,
      segment: {
        enabled: q.segment.enabled,
        bar: q.segment.bar,
        barOptions: SEGMENT_BARS.map((b) => ({ value: b, label: SEGMENT_BAR_LABELS[b], selected: b === q.segment.bar })),
        allocated: q.segment.allocated,
        ticked: q.segment.ticked,
        pips: buildSegmentPips(q.segment),
      },

      status: q.status,
    };
  }

  /* ---------------- listeners ---------------- */

  activateListeners(html) {
    super.activateListeners(html);
    const root = html[0];
    root.addEventListener("click", (ev) => this._onClick(ev));
    root.addEventListener("change", (ev) => this._onChange(ev));
  }

  _onClick(ev) {
    const el = ev.target.closest("[data-action]");
    if (!el) return;
    const action = el.dataset.action;
    const questId = el.closest("[data-quest-id]")?.dataset.questId ?? el.dataset.questId;

    switch (action) {
      case "toggle-log": Hooks.callAll("questLog.toggle"); break;

      case "toggle-config": this.configOpen = !this.configOpen; this.render(false); break;
      case "close-config": this.configOpen = false; this.render(false); break;

      case "prev-day": this._guardGm(() => this._advanceDate(-1)); break;
      case "next-day": this._guardGm(() => this._advanceDate(1)); break;
      case "open-jump-picker": {
        const data = loadQuestData();
        this.jumpView = { year: data.currentDateObj.year, monthIndex: data.currentDateObj.monthIndex };
        this.showJumpPicker = true;
        this.render(false);
        break;
      }
      case "close-jump-picker": this.showJumpPicker = false; this.render(false); break;
      case "jump-prev-month": { const data = loadQuestData(); this.jumpView = shiftMonth(data.calendar, this.jumpView, -1); this.render(false); break; }
      case "jump-next-month": { const data = loadQuestData(); this.jumpView = shiftMonth(data.calendar, this.jumpView, 1); this.render(false); break; }
      case "jump-today": { const data = loadQuestData(); this.jumpView = { year: data.currentDateObj.year, monthIndex: data.currentDateObj.monthIndex }; this.render(false); break; }
      case "jump-to-day": this._guardGm(() => {
        const d = { year: Number(el.dataset.year), monthIndex: Number(el.dataset.month), day: Number(el.dataset.day) };
        const data = loadQuestData();
        data.currentDateObj = d;
        this.showJumpPicker = false;
        saveQuestData(data);
        this.render(false);
      }); break;

      case "toggle-calendar-panel": this.calendarPanelOpen = !this.calendarPanelOpen; this.render(false); break;
      case "cal-prev-month": { const data = loadQuestData(); this.calendarViewMonth = shiftMonth(data.calendar, this.calendarViewMonth, -1); this.render(false); break; }
      case "cal-next-month": { const data = loadQuestData(); this.calendarViewMonth = shiftMonth(data.calendar, this.calendarViewMonth, 1); this.render(false); break; }
      case "cal-today": { const data = loadQuestData(); this.calendarViewMonth = { year: data.currentDateObj.year, monthIndex: data.currentDateObj.monthIndex }; this.render(false); break; }
      case "select-calendar-day": {
        const key = el.dataset.key;
        this.selectedCalendarDay = this.selectedCalendarDay === key ? null : key;
        this.calendarEventDraft = "";
        this.render(false);
        break;
      }
      case "add-calendar-event": this._guardGm(() => {
        if (!this.selectedCalendarDay) return;
        const text = this.calendarEventDraft.trim();
        if (!text) return;
        const data = loadQuestData();
        const key = this.selectedCalendarDay;
        data.calendarEvents[key] = [...(data.calendarEvents[key] || []), { id: `e${data.nextEventId++}`, text }];
        this.calendarEventDraft = "";
        saveQuestData(data);
      }); break;
      case "delete-calendar-event": this._guardGm(() => {
        const key = el.dataset.key;
        const id = el.dataset.id;
        const data = loadQuestData();
        data.calendarEvents[key] = (data.calendarEvents[key] || []).filter((e) => e.id !== id);
        saveQuestData(data);
      }); break;

      case "set-tab": this.activeTab = el.dataset.key; this.render(false); break;
      case "start-rename-tab": {
        const data = loadQuestData();
        this.editingTabKey = el.dataset.key;
        this.tabNameDraft = data.tabs[el.dataset.key]?.label || "";
        this.render(false);
        break;
      }
      case "cancel-rename-tab": this.editingTabKey = null; this.tabNameDraft = ""; this.render(false); break;
      case "confirm-rename-tab": this._guardGm(() => {
        const key = this.editingTabKey;
        if (!key) return;
        const name = this.tabNameDraft.trim();
        this.editingTabKey = null;
        this.tabNameDraft = "";
        if (!name) { this.render(false); return; }
        const data = loadQuestData();
        data.tabs[key] = { ...data.tabs[key], label: name };
        saveQuestData(data);
      }); break;
      case "delete-tab": this._guardGm(() => {
        const key = el.dataset.key;
        const data = loadQuestData();
        if (!data.tabs[key]) return;
        const removedIds = new Set(data.tabs[key].quests.map((q) => q.id));
        delete data.tabs[key];
        const remaining = Object.keys(data.tabs);
        if (this.activeTab === key) this.activeTab = remaining[0] || "finished";
        if (removedIds.has(this.expandedId)) this.expandedId = null;
        saveQuestData(data);
      }); break;
      case "open-add-tab-input": this.showAddTabInput = true; this.newTabDraft = ""; this.render(false); break;
      case "cancel-add-tab-input": this.showAddTabInput = false; this.newTabDraft = ""; this.render(false); break;
      case "add-tab": this._guardGm(() => {
        const name = this.newTabDraft.trim();
        this.showAddTabInput = false;
        this.newTabDraft = "";
        if (!name) { this.render(false); return; }
        const data = loadQuestData();
        const key = `tab${data.nextTabId++}`;
        data.tabs[key] = { label: name, categories: [], quests: [] };
        this.activeTab = key;
        saveQuestData(data);
      }); break;

      case "set-category": this.activeCategory[this.activeTab] = el.dataset.cat; this.render(false); break;
      case "open-category-input": this.showCatInput = true; this.catDraft = ""; this.render(false); break;
      case "cancel-category-input": this.showCatInput = false; this.catDraft = ""; this.render(false); break;
      case "add-category": this._guardGm(() => {
        const name = this.catDraft.trim();
        this.showCatInput = false;
        this.catDraft = "";
        if (!name) { this.render(false); return; }
        const data = loadQuestData();
        const tab = data.tabs[this.activeTab];
        if (tab && !tab.categories.includes(name)) tab.categories.push(name);
        saveQuestData(data);
      }); break;
      case "delete-category": this._guardGm(() => {
        const cat = el.dataset.cat;
        const data = loadQuestData();
        const tab = data.tabs[this.activeTab];
        if (!tab) return;
        tab.categories = tab.categories.filter((c) => c !== cat);
        if (this.activeCategory[this.activeTab] === cat) this.activeCategory[this.activeTab] = "all";
        saveQuestData(data);
      }); break;

      case "open-add-form": {
        const data = loadQuestData();
        const tab = this.activeTab === "finished" ? Object.keys(data.tabs)[0] : this.activeTab;
        this.showAddForm = true;
        this.draft = { title: "", tab, category: (data.tabs[tab]?.categories || [])[0] || "", summary: "" };
        this.render(false);
        break;
      }
      case "close-add-form": this.showAddForm = false; this.render(false); break;
      case "submit-quest": this._guardGm(() => {
        const title = this.draft.title.trim();
        this.showAddForm = false;
        if (!title) { this.render(false); return; }
        const data = loadQuestData();
        const newQuest = {
          id: `q${data.nextQuestId++}`,
          title,
          category: this.draft.category || "Uncategorised",
          status: "active",
          dateLogged: currentDateLabel(data),
          summary: this.draft.summary.trim() || "No summary yet.",
          updates: [],
          playerNotes: [],
          segment: { enabled: false, bar: "day", allocated: 5, ticked: 0 },
          linkedDate: null,
        };
        data.tabs[this.draft.tab].quests.push(newQuest);
        this.activeTab = this.draft.tab;
        this.expandedId = newQuest.id;
        saveQuestData(data);
      }); break;

      case "toggle-expand": this.expandedId = this.expandedId === questId ? null : questId; this.render(false); break;
      case "delete-quest": this._guardGm(() => {
        const data = loadQuestData();
        const loc = findQuestLocation(data, questId);
        if (!loc) return;
        data.tabs[loc.tabKey].quests.splice(loc.idx, 1);
        if (this.expandedId === questId) this.expandedId = null;
        saveQuestData(data);
      }); break;

      case "add-update": this._guardGm(() => {
        const text = (this._updateDrafts[questId] || "").trim();
        if (!text) return;
        const data = loadQuestData();
        const loc = findQuestLocation(data, questId);
        if (!loc) return;
        const quest = data.tabs[loc.tabKey].quests[loc.idx];
        const today = currentDateLabel(data);
        quest.updates.push({ id: `n${data.nextNoteId++}`, text, dateWritten: today, revealed: false, dateRevealed: null });
        this._updateDrafts[questId] = "";
        saveQuestData(data);
      }); break;
      case "toggle-reveal": this._guardGm(() => {
        const noteId = el.dataset.noteId;
        const data = loadQuestData();
        const loc = findQuestLocation(data, questId);
        if (!loc) return;
        const quest = data.tabs[loc.tabKey].quests[loc.idx];
        const today = currentDateLabel(data);
        quest.updates = quest.updates.map((n) => {
          if (n.id !== noteId) return n;
          const revealed = !n.revealed;
          return { ...n, revealed, dateRevealed: revealed ? today : n.dateRevealed };
        });
        saveQuestData(data);
      }); break;
      case "delete-update": this._guardGm(() => {
        const noteId = el.dataset.noteId;
        const data = loadQuestData();
        const loc = findQuestLocation(data, questId);
        if (!loc) return;
        const quest = data.tabs[loc.tabKey].quests[loc.idx];
        quest.updates = quest.updates.filter((n) => n.id !== noteId);
        saveQuestData(data);
      }); break;

      case "add-player-note": {
        const text = (this._noteDrafts[questId] || "").trim();
        if (!text) return;
        requestAddPlayerNote(questId, text);
        this._noteDrafts[questId] = "";
        this.render(false);
        break;
      }
      case "delete-player-note": this._guardGm(() => {
        const noteId = el.dataset.noteId;
        const data = loadQuestData();
        const loc = findQuestLocation(data, questId);
        if (!loc) return;
        const quest = data.tabs[loc.tabKey].quests[loc.idx];
        quest.playerNotes = quest.playerNotes.filter((n) => n.id !== noteId);
        saveQuestData(data);
      }); break;

      case "open-set-date": this._guardGm(() => {
        const data = loadQuestData();
        const loc = findQuestLocation(data, questId);
        if (!loc) return;
        const quest = data.tabs[loc.tabKey].quests[loc.idx];
        const base = quest.linkedDate || data.currentDateObj;
        this.questDatePicker = { questId, year: base.year, monthIndex: base.monthIndex, day: base.day };
        this.render(false);
      }); break;
      case "clear-linked-date": this._guardGm(() => {
        const data = loadQuestData();
        const loc = findQuestLocation(data, questId);
        if (!loc) return;
        data.tabs[loc.tabKey].quests[loc.idx].linkedDate = null;
        saveQuestData(data);
      }); break;
      case "quest-date-cancel": this.questDatePicker = { questId: null, year: 0, monthIndex: 0, day: 1 }; this.render(false); break;
      case "quest-date-confirm": this._guardGm(() => {
        const dp = this.questDatePicker;
        if (!dp.questId) return;
        const data = loadQuestData();
        const loc = findQuestLocation(data, dp.questId);
        this.questDatePicker = { questId: null, year: 0, monthIndex: 0, day: 1 };
        if (!loc) return;
        data.tabs[loc.tabKey].quests[loc.idx].linkedDate = { year: dp.year, monthIndex: dp.monthIndex, day: dp.day };
        saveQuestData(data);
      }); break;

      case "segment-inc": this._guardGm(() => this._changeSegmentAllocated(questId, 1)); break;
      case "segment-dec": this._guardGm(() => this._changeSegmentAllocated(questId, -1)); break;
      case "segment-tick": this._guardGm(() => {
        const data = loadQuestData();
        const loc = findQuestLocation(data, questId);
        if (!loc) return;
        const seg = data.tabs[loc.tabKey].quests[loc.idx].segment;
        seg.ticked = Math.min(seg.allocated, seg.ticked + 1);
        saveQuestData(data);
      }); break;
      case "segment-reset": this._guardGm(() => {
        const data = loadQuestData();
        const loc = findQuestLocation(data, questId);
        if (!loc) return;
        data.tabs[loc.tabKey].quests[loc.idx].segment.ticked = 0;
        saveQuestData(data);
      }); break;

      case "add-month": this._guardGm(() => {
        const data = loadQuestData();
        data.calendar.months.push({ name: "New Month", days: 30 });
        saveQuestData(data);
      }); break;
      case "delete-month": this._guardGm(() => {
        const idx = Number(el.dataset.idx);
        const data = loadQuestData();
        if (data.calendar.months.length <= 1) return;
        data.calendar.months.splice(idx, 1);
        data.currentDateObj = clampDateToCalendar(data.calendar, data.currentDateObj);
        saveQuestData(data);
      }); break;

      default: break;
    }
  }

  _onChange(ev) {
    const el = ev.target.closest("[data-action]");
    if (!el) return;
    const action = el.dataset.action;
    const questId = el.closest("[data-quest-id]")?.dataset.questId ?? el.dataset.questId;

    switch (action) {
      case "draft-title-change": this.draft.title = el.value; break;
      case "draft-tab-change": {
        const data = loadQuestData();
        this.draft.tab = el.value;
        this.draft.category = (data.tabs[el.value]?.categories || [])[0] || "";
        this.render(false);
        return;
      }
      case "draft-category-change": this.draft.category = el.value; break;
      case "draft-summary-change": this.draft.summary = el.value; break;

      case "cat-draft-change": this.catDraft = el.value; break;
      case "new-tab-draft-change": this.newTabDraft = el.value; break;
      case "tab-name-draft-change": this.tabNameDraft = el.value; break;

      case "update-draft-change": this._updateDrafts[questId] = el.value; return;
      case "note-draft-change": this._noteDrafts[questId] = el.value; return;

      case "calendar-event-draft-change": this.calendarEventDraft = el.value; break;

      case "status-change": this._guardGm(() => {
        const data = loadQuestData();
        const loc = findQuestLocation(data, questId);
        if (!loc) return;
        data.tabs[loc.tabKey].quests[loc.idx].status = el.value;
        saveQuestData(data);
      }); return;

      case "toggle-segment-enabled": this._guardGm(() => {
        const data = loadQuestData();
        const loc = findQuestLocation(data, questId);
        if (!loc) return;
        data.tabs[loc.tabKey].quests[loc.idx].segment.enabled = el.checked;
        saveQuestData(data);
      }); return;
      case "segment-bar-change": this._guardGm(() => {
        const data = loadQuestData();
        const loc = findQuestLocation(data, questId);
        if (!loc) return;
        data.tabs[loc.tabKey].quests[loc.idx].segment.bar = el.value;
        saveQuestData(data);
      }); return;

      case "quest-date-year-change": this.questDatePicker.year = parseInt(el.value, 10) || 0; return;
      case "quest-date-month-change": {
        const data = loadQuestData();
        const monthIndex = parseInt(el.value, 10) || 0;
        const maxDay = data.calendar.months[monthIndex]?.days || 30;
        this.questDatePicker.monthIndex = monthIndex;
        this.questDatePicker.day = Math.min(this.questDatePicker.day, maxDay);
        this.render(false);
        return;
      }
      case "quest-date-day-change": this.questDatePicker.day = parseInt(el.value, 10) || 1; return;

      case "toggle-show-calendar-section": this._guardGm(() => {
        const data = loadQuestData();
        data.showCalendarSection = el.checked;
        saveQuestData(data);
      }); return;
      case "toggle-show-segment-section": this._guardGm(() => {
        const data = loadQuestData();
        data.showSegmentSection = el.checked;
        saveQuestData(data);
      }); return;
      case "toggle-use-simple-calendar": this._guardGm(() => {
        const data = loadQuestData();
        data.useSimpleCalendar = el.checked;
        saveQuestData(data);
      }); return;
      case "year-label-change": this._guardGm(() => {
        const data = loadQuestData();
        data.calendar.yearLabel = el.value;
        saveQuestData(data);
      }); return;
      case "month-name-change": this._guardGm(() => {
        const idx = Number(el.dataset.idx);
        const data = loadQuestData();
        data.calendar.months[idx].name = el.value;
        saveQuestData(data);
      }); return;
      case "month-days-change": this._guardGm(() => {
        const idx = Number(el.dataset.idx);
        const days = Math.max(1, parseInt(el.value, 10) || 1);
        const data = loadQuestData();
        data.calendar.months[idx].days = days;
        data.currentDateObj = clampDateToCalendar(data.calendar, data.currentDateObj);
        saveQuestData(data);
      }); return;

      default: break;
    }

    this.render(false);
  }

  _guardGm(fn) {
    if (!game.user.isGM) return;
    fn();
  }

  _advanceDate(delta) {
    const data = loadQuestData();
    data.currentDateObj = addDays(data.calendar, data.currentDateObj, delta);
    saveQuestData(data);
  }

  _changeSegmentAllocated(questId, delta) {
    const data = loadQuestData();
    const loc = findQuestLocation(data, questId);
    if (!loc) return;
    const seg = data.tabs[loc.tabKey].quests[loc.idx].segment;
    seg.allocated = Math.min(20, Math.max(1, seg.allocated + delta));
    seg.ticked = Math.min(seg.ticked, seg.allocated);
    saveQuestData(data);
  }
}

/* =========================================================================
   Scene Controls toolbar button (the "Q" tool, GM only), settings, hooks.
   ========================================================================= */

let app = null;

function toggleApp() {
  if (!app) app = new QuestLogApp();
  if (app.rendered) app.close();
  else app.render(true);
}

function addSceneControlButton(controls) {
  if (Array.isArray(controls)) {
    const tool = {
      name: "shrimpsQuestLog",
      title: "Shrimps Quest Log",
      icon: "fas fa-scroll",
      button: true,
      onClick: toggleApp,
    };
    const notes = controls.find((c) => c.name === "notes") ?? controls.find((c) => c.name === "token");
    if (notes && !notes.tools.some((t) => t.name === tool.name)) notes.tools.push(tool);
    return;
  }

  const tool = {
    name: "shrimpsQuestLog",
    title: "Shrimps Quest Log",
    icon: "fas fa-scroll",
    button: true,
    onChange: toggleApp,
  };
  const notes = controls.notes ?? controls.token;
  if (notes && notes.tools && !notes.tools[tool.name]) notes.tools[tool.name] = tool;
}

Hooks.once("init", () => {
  registerSettings();
});

Hooks.once("ready", () => {
  game.socket.on(SOCKET_NAME, onSocketMessage);
});

Hooks.on("questLog.toggle", () => toggleApp());

Hooks.on("getSceneControlButtons", (controls) => {
  addSceneControlButton(controls);
});

Hooks.on("updateSetting", (setting) => {
  const key = setting.key ?? "";

  if (key === `${MODULE_ID}.data`) {
    if (app?.rendered) app.render(false);
    return;
  }

  if (key.startsWith(`${SC_MODULE_ID}.`)) {
    const settingName = key.split(".")[1];
    const bar = settingName?.endsWith("Filled") ? settingName.replace("Filled", "") : null;
    if (bar && SEGMENT_BARS.includes(bar)) applySegmentTick(bar, setting.value);
  }
});
