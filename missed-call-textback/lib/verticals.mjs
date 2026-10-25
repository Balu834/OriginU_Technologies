/**
 * What kind of business this is decides what the conversation asks.
 *
 * The product started with electricians, so the default ("services") asks
 * for the problem, area, name and how soon, and watches for safety signals
 * (sparking, burning, leaks). A wedding makeup artist or caterer needs the
 * occasion and the event date instead, and has no use for a "switch off at
 * the mains" message, so those businesses get the "events" set.
 *
 * The type is read from the business's own industry text, so businesses
 * created before this existed are classified without a migration.
 */

const EVENTS_RE =
  /\b(wedding|weddings|event|events|makeup|make-up|make up|bridal|bride|mehendi|mehndi|henna|photo|photography|photographer|photographers|video|videography|catering|caterer|caterers|decor|decoration|decorator|planner|planners|planning|dj|venue|banquet|beauty|salon|parlou?r)\b/i;

export const VERTICALS = {
  services: {
    fieldOrder: ["problem", "area", "name", "urgency"],
    questionKeys: { problem: "ask_problem", area: "ask_area", name: "ask_name", urgency: "ask_urgency" },
    templatesKey: "_conversation",
    emergencyChecks: true,
  },
  events: {
    fieldOrder: ["problem", "date", "area", "name"],
    questionKeys: { problem: "ask_problem", date: "ask_date", area: "ask_area", name: "ask_name" },
    templatesKey: "_conversation_events",
    emergencyChecks: false,
  },
};

export function verticalFor(context) {
  const industry = String(context?.industry ?? "");
  return EVENTS_RE.test(industry) ? "events" : "services";
}

export function verticalConfig(context) {
  return VERTICALS[verticalFor(context)];
}
