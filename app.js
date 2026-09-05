let DATA = [];
let ALTERNATIVE_GROUPS = [];

const $ = (id) => document.getElementById(id);

const CYRILLIC_TO_LATIN = {
  "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M",
  "Н": "H", "О": "O", "Р": "P", "С": "C", "Т": "T", "Х": "X",
};

function normalizeLetters(value) {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[АВЕКМНОРСТХ]/g, ch => CYRILLIC_TO_LATIN[ch] || ch)
    .replace(/[–—−]/g, "-");
}

function normalizeICD(value) {
  return normalizeLetters(value).trim().replace(/\s+/g, "");
}

function normalizeCategory(value) {
  return normalizeLetters(value)
    .replace(/\r?\n+/g, ";")
    .replace(/\s+/g, " ")
    .trim();
}

async function loadData() {
  const [dataResponse, alternativesResponse] = await Promise.all([
    fetch("mse_data.json", { cache: "no-store" }),
    fetch("alternative_groups.json", { cache: "no-store" }),
  ]);

  if (!dataResponse.ok) throw new Error("Не удалось загрузить базу обследований.");
  if (!alternativesResponse.ok) throw new Error("Не удалось загрузить группы альтернативных обследований.");

  const raw = await dataResponse.json();
  const alternatives = await alternativesResponse.json();

  if (!Array.isArray(raw)) throw new Error("Файл mse_data.json имеет неверный формат.");
  if (!Array.isArray(alternatives)) throw new Error("Файл alternative_groups.json имеет неверный формат.");

  // Приложение предназначено только для раздела I приказа — лиц 18 лет и старше.
  DATA = raw.filter(row => String(row.SECTION ?? "1").trim() === "1");
  ALTERNATIVE_GROUPS = alternatives;

  $("searchBtn").disabled = false;
  $("icdHint").textContent = "Можно вводить латинскими или русскими буквами, например A18.2 или А18.2.";
}

function validIcd(code) {
  return /^[A-Z]\d{2}(?:\.\d{1,2})?$/.test(code);
}

function parseIcd(code) {
  const m = code.match(/^([A-Z])(\d{2})(?:\.(\d{1,2}))?$/);
  if (!m) return null;

  return {
    letter: m[1],
    major: Number(m[2]),
    decimals: m[3] ? m[3].split("").map(Number) : [],
  };
}

function compareIcd(a, b) {
  const pa = parseIcd(a);
  const pb = parseIcd(b);
  if (!pa || !pb) return NaN;

  if (pa.letter !== pb.letter) return pa.letter.localeCompare(pb.letter);
  if (pa.major !== pb.major) return pa.major - pb.major;

  const n = Math.max(pa.decimals.length, pb.decimals.length);
  for (let i = 0; i < n; i++) {
    const x = pa.decimals[i] ?? -1;
    const y = pb.decimals[i] ?? -1;
    if (x !== y) return x - y;
  }
  return 0;
}

function codeInRange(code, start, end) {
  if (!validIcd(code) || !validIcd(start) || !validIcd(end)) return false;

  const aboveLower = compareIcd(code, start) >= 0;
  // Если верхняя граница — рубрика A19, она должна включать и A19.0, A19.1 и т. п.
  const belowUpper = compareIcd(code, end) <= 0 || code.startsWith(end + ".");
  return aboveLower && belowUpper;
}

function matchPart(code, part) {
  const normalized = normalizeICD(part);
  if (!normalized) return false;

  if (normalized.includes("-")) {
    const range = normalized.split("-").map(s => s.trim()).filter(Boolean);
    return range.length === 2 && codeInRange(code, range[0], range[1]);
  }

  if (!validIcd(normalized)) return false;

  // Рубрика A18 включает A18.2, но A18.2 не включает A18.20.
  return code === normalized || code.startsWith(normalized + ".");
}

function icdMatches(userCode, category) {
  const code = normalizeICD(userCode);
  if (!validIcd(code) || !category) return false;

  const parts = normalizeCategory(category)
    .split(/[;,]+/)
    .map(s => s.trim())
    .filter(Boolean);

  return parts.some(part => matchPart(code, part));
}

function rangeWidth(start, end) {
  const a = parseIcd(start);
  const b = parseIcd(end);
  if (!a || !b) return 9999;

  const letterGap = b.letter.charCodeAt(0) - a.letter.charCodeAt(0);
  const majorGap = b.major - a.major;
  return Math.max(0, letterGap * 100 + majorGap);
}

function getMatchSpecificity(code, category) {
  const parts = normalizeCategory(category)
    .split(/[;,]+/)
    .map(s => s.trim())
    .filter(Boolean);

  let best = -Infinity;

  for (const rawPart of parts) {
    const part = normalizeICD(rawPart);

    if (part.includes("-")) {
      const [start, end] = part.split("-");
      if (codeInRange(code, start, end)) {
        best = Math.max(best, 1000 - Math.min(rangeWidth(start, end), 900));
      }
      continue;
    }

    if (validIcd(part) && (code === part || code.startsWith(part + "."))) {
      const decimalBonus = part.includes(".") ? 200 : 0;
      best = Math.max(best, 2000 + decimalBonus + part.length);
    }
  }

  return best;
}

function getField(row, candidates) {
  for (const key of candidates) {
    if (Object.prototype.hasOwnProperty.call(row, key)) {
      return String(row[key] ?? "").trim();
    }
  }
  return "";
}

function getServiceCode(row) {
  return getField(row, [
    "NMU_CODE", "CODE_NMU", "CODE_MU", "CODE_SERVICE", "SERVICE_CODE",
    "Код медицинской услуги", "КОД НМУ", "CODE",
  ]);
}

function getServiceName(row) {
  return getField(row, [
    "DESCRIPTION", "NAME_NMU", "NAME_MU", "SERVICE_NAME", "NAME_SERVICE",
    "Наименование медицинской услуги", "НАИМЕНОВАНИЕ НМУ", "NAME",
  ]);
}

function getCategory(row) {
  return getField(row, ["CATEGORY_ICD10", "ICD10", "МКБ-10", "ICD", "CATEGORY"]);
}

function getValidityText(row) {
  return getField(row, [
    "DATE", "VALIDITY", "VALIDITY_PERIOD", "TERM", "Срок давности",
    "Срок годности", "VALIDITY_TEXT",
  ]);
}

function getBasicAdditional(row) {
  return getField(row, ["BASIC_ADDITIONAL", "BASIC", "MAIN_ADDITIONAL"]);
}

function getRowId(row) {
  const value = Number(getField(row, ["ID"]));
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function getRowIdString(row) {
  return getField(row, ["ID"]);
}

function directionFlags(text) {
  const s = String(text || "").toLowerCase();
  return {
    primary: /при\s+первичн[а-яё]*\s+направлен[а-яё]*/i.test(s),
    repeat: /при\s+повторн[а-яё]*\s+направлен[а-яё]*/i.test(s),
  };
}

function rowAppliesToDirection(row, direction) {
  const text = getValidityText(row);
  const flags = directionFlags(text);

  if (flags.primary && !flags.repeat) return direction === "primary";
  if (flags.repeat && !flags.primary) return direction === "repeat";
  return true;
}

const PERIOD_VALUE = "(?:бессрочно|\\d+\\s*(?:календарн(?:ых|ые|ый|ого)?\\s*)?(?:день|дня|дней|год|года|лет|месяц|месяца|месяцев))";

function parsePeriodToken(token) {
  const s = String(token || "").trim().toLowerCase();
  if (!s) return null;

  if (/бессроч/.test(s)) {
    return { unit: "unlimited", amount: null, label: "Бессрочно" };
  }

  const nMatch = s.match(/\d+/);
  if (!nMatch) return null;
  const amount = Number(nMatch[0]);

  if (/день|дня|дней/.test(s)) {
    return { unit: "days", amount, label: `${amount} дней` };
  }
  if (/год|года|лет/.test(s)) {
    return { unit: "years", amount, label: formatYears(amount) };
  }
  if (/месяц|месяца|месяцев/.test(s)) {
    return { unit: "months", amount, label: formatMonths(amount) };
  }

  return null;
}

function formatYears(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} год`;
  if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return `${n} года`;
  return `${n} лет`;
}

function formatMonths(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} месяц`;
  if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return `${n} месяца`;
  return `${n} месяцев`;
}

function cleanValidityLabel(text) {
  return String(text || "")
    .replace(/^\s*действительно\s*/i, "")
    .trim()
    .replace(/^./, ch => ch.toUpperCase());
}

function extractDirectionalPeriods(text) {
  const result = {};

  const beforeDirection = new RegExp(
    `(${PERIOD_VALUE})\\s*при\\s*(первичн[а-яё]*|повторн[а-яё]*)\\s*направлен[а-яё]*`,
    "gi",
  );
  const afterDirection = new RegExp(
    `при\\s*(первичн[а-яё]*|повторн[а-яё]*)\\s*направлен[а-яё]*\\s*[:—-]?\\s*(${PERIOD_VALUE})`,
    "gi",
  );

  for (const match of String(text || "").matchAll(beforeDirection)) {
    const key = match[2].toLowerCase().startsWith("первич") ? "primary" : "repeat";
    result[key] = parsePeriodToken(match[1]);
  }

  for (const match of String(text || "").matchAll(afterDirection)) {
    const key = match[1].toLowerCase().startsWith("первич") ? "primary" : "repeat";
    result[key] = parsePeriodToken(match[2]);
  }

  return result;
}

function parseValidity(text, direction) {
  const s = String(text || "").trim();
  if (!s) return null;

  const directional = extractDirectionalPeriods(s);
  if (directional[direction]) {
    return {
      ...directional[direction],
      conditional: false,
      rawLabel: directional[direction].label,
    };
  }

  const flags = directionFlags(s);
  if ((flags.primary || flags.repeat) && !directional[direction]) return null;

  const allValues = [...s.matchAll(new RegExp(PERIOD_VALUE, "gi"))];
  if (!allValues.length) {
    return { unit: "unknown", amount: null, label: cleanValidityLabel(s), conditional: false, rawLabel: cleanValidityLabel(s) };
  }

  const first = parsePeriodToken(allValues[0][0]);
  if (!first) return null;

  const conditional = allValues.length > 1;
  const label = conditional ? cleanValidityLabel(s) : first.label;

  return {
    ...first,
    label,
    rawLabel: label,
    conditional,
    hasUnlimitedAlternative: conditional && /бессроч/i.test(s),
  };
}

function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function subtractPeriod(dateString, validity) {
  const [year, month, day] = dateString.split("-").map(Number);
  if (!year || !month || !day || !validity) return "—";

  if (validity.unit === "unlimited") return "Без ограничения по дате";
  if (validity.unit === "unknown" || validity.amount === null) return "См. срок годности";

  let result;

  if (validity.unit === "days") {
    result = new Date(year, month - 1, day);
    result.setDate(result.getDate() - validity.amount);
  } else if (validity.unit === "years") {
    const targetYear = year - validity.amount;
    const targetMonth = month - 1;
    const targetDay = Math.min(day, daysInMonth(targetYear, targetMonth));
    result = new Date(targetYear, targetMonth, targetDay);
  } else if (validity.unit === "months") {
    const totalMonths = year * 12 + (month - 1) - validity.amount;
    const targetYear = Math.floor(totalMonths / 12);
    const targetMonth = ((totalMonths % 12) + 12) % 12;
    const targetDay = Math.min(day, daysInMonth(targetYear, targetMonth));
    result = new Date(targetYear, targetMonth, targetDay);
  } else {
    return "См. срок годности";
  }

  const date = result.toLocaleDateString("ru-RU");
  if (validity.hasUnlimitedAlternative) {
    return `${date} (либо бессрочно по условию)`;
  }
  return date;
}

function dedupeMatches(code, rows) {
  const selected = new Map();

  for (const row of rows) {
    const key = `${getServiceCode(row)}|${getServiceName(row)}`;
    const specificity = getMatchSpecificity(code, getCategory(row));
    const isBasic = getBasicAdditional(row) === "1";
    const current = selected.get(key);

    if (
      !current ||
      specificity > current.specificity ||
      (specificity === current.specificity && isBasic && !current.isBasic)
    ) {
      selected.set(key, { row, specificity, isBasic });
    }
  }

  return [...selected.values()]
    .map(item => item.row)
    .sort((a, b) => getRowId(a) - getRowId(b));
}

function toggleValidFromColumn(show) {
  document.querySelectorAll(".valid-from-col").forEach(el => {
    el.classList.toggle("hidden-col", !show);
  });
}

function appendSectionRow(tbody, title, note, showValidFrom) {
  const tr = document.createElement("tr");
  tr.className = "section-row";

  const td = document.createElement("td");
  td.colSpan = showValidFrom ? 5 : 4;
  td.innerHTML = `<strong>${escapeHtml(title)}</strong>${note ? `<span>${escapeHtml(note)}</span>` : ""}`;
  tr.appendChild(td);
  tbody.appendChild(tr);
}

function appendServiceRow(tbody, row, direction, mseDate, options = {}) {
  const validity = parseValidity(getValidityText(row), direction);
  if (!validity) return null;

  const tr = document.createElement("tr");
  const classNames = [];
  if (options.className) classNames.push(options.className);
  if (options.alternativeGroupId) classNames.push("alternative-row");
  tr.className = classNames.join(" ");

  if (options.alternativeGroupId) {
    tr.dataset.altGroup = options.alternativeGroupId;
    tr.dataset.altOption = String(options.alternativeOptionIndex);
    tr.dataset.altKind = options.kind || "basic";
  }

  const validFrom = mseDate ? subtractPeriod(mseDate, validity) : "";

  let optionLabel = "";
  if (options.optionLabel) {
    const cls = options.alternativeOptionIndex === 0
      ? "option-badge"
      : "alternative-sub-label";
    const prefix = options.alternativeOptionIndex === 0 ? "" : "↳ ИЛИ — ";
    optionLabel = `<span class="${cls}">${prefix}${escapeHtml(options.optionLabel)}</span>`;
  }

  let printControls = "";

  if (options.alternativeGroupId && options.firstInOption) {
    const radioName = `alt-print-${options.alternativeGroupId}`;
    printControls += `
      <label class="print-control alternative-choice-control">
        <input
          class="alternative-choice"
          type="radio"
          name="${escapeHtml(radioName)}"
          value="${options.alternativeOptionIndex}"
          data-group-id="${escapeHtml(options.alternativeGroupId)}"
        >
        Печатать этот вариант
      </label>
    `;
  }

  if (options.additionalPlain) {
    printControls += `
      <label class="print-control exclude-print-control">
        <input class="exclude-print-toggle" type="checkbox">
        Не печатать
      </label>
    `;
  }

  // Для дополнительной группы «ИЛИ» достаточно одного общего переключателя:
  // можно исключить весь блок, если по показаниям он не нужен.
  if (options.additionalAlternativeGroup && options.alternativeOptionIndex === 0 && options.firstInOption) {
    printControls += `
      <label class="print-control exclude-group-control">
        <input
          class="exclude-alt-group-toggle"
          type="checkbox"
          data-group-id="${escapeHtml(options.alternativeGroupId)}"
        >
        Не печатать эту группу
      </label>
    `;
  }

  tr.innerHTML = `
    <td class="check-col"><input class="check" type="checkbox" aria-label="Выполнено"></td>
    <td class="service-code">${escapeHtml(getServiceCode(row))}</td>
    <td>
      ${optionLabel}${escapeHtml(getServiceName(row))}
      ${printControls ? `<div class="print-controls">${printControls}</div>` : ""}
    </td>
    <td>${escapeHtml(validity.label)}</td>
    <td class="valid-from-col${mseDate ? "" : " hidden-col"}">${escapeHtml(validFrom)}</td>
  `;

  tbody.appendChild(tr);

  const rowExclude = tr.querySelector(".exclude-print-toggle");
  if (rowExclude) {
    rowExclude.addEventListener("change", () => {
      tr.classList.toggle("print-excluded-user", rowExclude.checked);
    });
  }

  const choice = tr.querySelector(".alternative-choice");
  if (choice) {
    choice.addEventListener("change", () => {
      updateAlternativePrintState(options.alternativeGroupId);
    });
  }

  const groupExclude = tr.querySelector(".exclude-alt-group-toggle");
  if (groupExclude) {
    groupExclude.addEventListener("change", () => {
      updateAlternativePrintState(options.alternativeGroupId);
    });
  }

  return tr;
}

function getAlternativeGroups(code, kind, rows) {
  const rowById = new Map(rows.map(row => [getRowIdString(row), row]));

  return ALTERNATIVE_GROUPS
    .filter(group => group.kind === kind && icdMatches(code, group.category))
    .map(group => {
      const options = group.options.map(option => {
        const optionRows = option.row_ids
          .map(id => rowById.get(String(id)))
          .filter(Boolean);

        return {
          ...option,
          rows: optionRows,
          complete: optionRows.length === option.row_ids.length,
        };
      });

      // Группу показываем только целиком: иначе можно случайно создать ложное
      // впечатление, что часть предусмотренных приказом альтернатив отсутствует.
      if (options.length < 2 || !options.every(option => option.complete)) return null;

      return { ...group, options };
    })
    .filter(Boolean);
}

function getConsumedAlternativeRowIds(groups) {
  const ids = new Set();
  for (const group of groups) {
    for (const option of group.options) {
      for (const row of option.rows) ids.add(getRowIdString(row));
    }
  }
  return ids;
}

function updateAlternativePrintState(groupId) {
  const rows = [...document.querySelectorAll(`tr[data-alt-group="${CSS.escape(groupId)}"]`)];
  if (!rows.length) return;

  const checkedChoice = document.querySelector(
    `input.alternative-choice[data-group-id="${CSS.escape(groupId)}"]:checked`,
  );
  const groupExclude = document.querySelector(
    `input.exclude-alt-group-toggle[data-group-id="${CSS.escape(groupId)}"]`,
  );
  const excludeWholeGroup = Boolean(groupExclude && groupExclude.checked);
  const selectedOption = checkedChoice ? checkedChoice.value : null;

  for (const row of rows) {
    const wrongOption = selectedOption !== null && row.dataset.altOption !== selectedOption;
    row.classList.toggle("print-excluded-alternative", excludeWholeGroup || wrongOption);
  }

  // Если дополнительную группу исключили целиком, ее радиокнопки становятся
  // неактивными визуально, но выбранное значение сохраняется на случай возврата.
  document.querySelectorAll(
    `input.alternative-choice[data-group-id="${CSS.escape(groupId)}"]`,
  ).forEach(input => {
    input.disabled = excludeWholeGroup;
  });
}

function appendNestedAlternativeGroup(tbody, group, kind, direction, mseDate) {
  group.options.forEach((option, optionIndex) => {
    option.rows.forEach((row, rowIndex) => {
      appendServiceRow(tbody, row, direction, mseDate, {
        className: optionIndex === 0 ? "alternative-primary-row" : "alternative-suboption-row",
        optionLabel: rowIndex === 0 ? `Вариант ${optionIndex + 1}` : "",
        alternativeGroupId: group.id,
        alternativeOptionIndex: optionIndex,
        firstInOption: rowIndex === 0,
        kind,
        additionalAlternativeGroup: kind === "additional",
      });
    });
  });
}

function appendSectionWithAlternatives(tbody, code, kind, rows, direction, mseDate) {
  const groups = getAlternativeGroups(code, kind, rows);
  const consumed = getConsumedAlternativeRowIds(groups);

  // Сохраняем порядок приказа: обычные строки и блоки «ИЛИ» сортируются по
  // минимальному ID исходной строки. Первый вариант блока выглядит как обычная
  // строка, последующие — как вложенные подварианты.
  const items = [];

  rows
    .filter(row => !consumed.has(getRowIdString(row)))
    .forEach(row => {
      items.push({ type: "row", sortId: getRowId(row), row });
    });

  groups.forEach(group => {
    const ids = group.options.flatMap(option => option.rows.map(getRowId));
    items.push({
      type: "group",
      sortId: Math.min(...ids),
      group,
    });
  });

  items.sort((a, b) => a.sortId - b.sortId);

  for (const item of items) {
    if (item.type === "row") {
      appendServiceRow(tbody, item.row, direction, mseDate, {
        additionalPlain: kind === "additional",
      });
    } else {
      appendNestedAlternativeGroup(tbody, item.group, kind, direction, mseDate);
    }
  }
}

function validatePrintSelections() {
  const groups = new Map();

  document.querySelectorAll("tr[data-alt-group]").forEach(row => {
    const groupId = row.dataset.altGroup;
    if (!groups.has(groupId)) {
      groups.set(groupId, {
        kind: row.dataset.altKind || "basic",
        firstRow: row,
      });
    }
  });

  for (const [groupId, meta] of groups) {
    const exclude = document.querySelector(
      `input.exclude-alt-group-toggle[data-group-id="${CSS.escape(groupId)}"]`,
    );
    if (exclude && exclude.checked) continue;

    const selected = document.querySelector(
      `input.alternative-choice[data-group-id="${CSS.escape(groupId)}"]:checked`,
    );

    if (!selected) {
      showMessage(
        meta.kind === "additional"
          ? "Перед печатью выберите один вариант в каждом блоке «ИЛИ» дополнительных обследований или отметьте «Не печатать эту группу»."
          : "Перед печатью выберите один вариант в каждом основном блоке «ИЛИ».",
      );
      meta.firstRow.scrollIntoView({ behavior: "smooth", block: "center" });
      return false;
    }
  }

  return true;
}

function renderResult(code, direction, mseDate, rows, rawMatches) {
  const directionLabel = direction === "primary" ? "первичное" : "повторное";
  const showValidFrom = Boolean(mseDate);

  toggleValidFromColumn(showValidFrom);

  $("resultMeta").textContent =
    `МКБ-10: ${code} • Направление: ${directionLabel}` +
    (mseDate ? ` • Предполагаемая дата МСЭ: ${formatInputDate(mseDate)}` : "");

  const categories = [...new Set(rawMatches.map(getCategory).filter(Boolean))]
    .sort((a, b) => getMatchSpecificity(code, a) - getMatchSpecificity(code, b));

  $("matchedCategories").innerHTML =
    `<strong>Учтены рубрики приказа:</strong> ${categories.map(escapeHtml).join(" → ")}`;

  const tbody = $("resultsTable").querySelector("tbody");
  tbody.innerHTML = "";

  const basicRows = rows.filter(row => getBasicAdditional(row) !== "2");
  const additionalRows = rows.filter(row => getBasicAdditional(row) === "2");

  if (basicRows.length) {
    appendSectionRow(tbody, "Основные обследования", "", showValidFrom);
    appendSectionWithAlternatives(
      tbody, code, "basic", basicRows, direction, mseDate,
    );
  }

  if (additionalRows.length) {
    appendSectionRow(
      tbody,
      "Дополнительные обследования",
      "Проводятся по показаниям и условиям, указанным в наименовании услуги.",
      showValidFrom,
    );
    appendSectionWithAlternatives(
      tbody, code, "additional", additionalRows, direction, mseDate,
    );
  }

  $("result").classList.remove("hidden");
  $("printBtn").classList.remove("hidden");
}

function formatInputDate(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString("ru-RU");
}

function search() {
  const code = normalizeICD($("icdInput").value);
  const checkedDirection = document.querySelector('input[name="direction"]:checked');
  const direction = checkedDirection ? checkedDirection.value : "primary";
  const mseDate = $("mseDate").value;

  $("message").classList.add("hidden");
  $("result").classList.add("hidden");
  $("printBtn").classList.add("hidden");

  if (!validIcd(code)) {
    showMessage("Введите корректный код МКБ-10, например A18.2 или I10.");
    return;
  }

  $("icdInput").value = code;

  // 1) Находим все подходящие уровни: общий класс/диапазон + более точные рубрики.
  const categoryMatches = DATA.filter(row => icdMatches(code, getCategory(row)));

  if (!categoryMatches.length) {
    showMessage(`Для кода ${code} подходящих записей в взрослой части базы не найдено.`);
    return;
  }

  // 2) Пустой срок в текущей базе встречается только у ссылочных строк приказа,
  //    которые отсылают к обследованиям по пораженному органу и не являются
  //    самостоятельным обследованием с собственным сроком.
  const applicable = categoryMatches.filter(row => {
    return getValidityText(row) && rowAppliesToDirection(row, direction);
  });

  // 3) Если одна и та же услуга встречается и в общей, и в более точной рубрике,
  //    выбираем более специфичное правило. Это важно, если срок отличается.
  const unique = dedupeMatches(code, applicable);

  if (!unique.length) {
    showMessage(`Для кода ${code} при выбранном типе направления обследования не найдены.`);
    return;
  }

  renderResult(code, direction, mseDate, unique, categoryMatches);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  }[ch]));
}

function showMessage(text) {
  $("message").textContent = text;
  $("message").classList.remove("hidden");
}

$("searchBtn").addEventListener("click", search);
$("printBtn").addEventListener("click", () => {
  $("message").classList.add("hidden");
  if (!validatePrintSelections()) return;
  window.print();
});
$("icdInput").addEventListener("keydown", event => {
  if (event.key === "Enter") search();
});

$("searchBtn").disabled = true;
loadData().catch(err => {
  $("searchBtn").disabled = true;
  showMessage(err.message);
});
