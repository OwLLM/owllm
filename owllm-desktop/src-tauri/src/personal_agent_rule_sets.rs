//! Rule-set profiles — the deterministic core.
//!
//! A rule set is a named, versioned, PROJECT-SCOPED bundle of behavioural rules
//! (software development, scientific research, social-media management, or a
//! user fork of one of those). Sets are assigned in two layers:
//!
//!   * agent layer   — `ProjectAgentConfigDoc.profileOverrides[id].ruleSetRefs`
//!   * project layer — `ProjectAgentConfigDoc.ruleSetRefs`
//!
//! Both live in the project's own encrypted store, so a set can never be seen
//! from, or attached to, another project: `compatibility_errors` rejects any set
//! whose `projectId` is not the resolving project, and the caller only ever
//! hands us documents loaded from that project's scope.
//!
//! Everything here is pure — no tauri, no filesystem, no clock — so the same
//! functions the app resolves with are executed by `rulesets-harness` via
//! `#[path]`. `personal_agents.rs` owns storage and the uuid-shaped id check;
//! this module owns the ordering and the conflict outcome.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

pub const RULE_SET_SCHEMA_VERSION: u32 = 1;

/// Built-in template ids, in catalogue order. The order is part of the
/// precedence key, so it must stay stable: it is the last deterministic
/// tie-break before the set id itself.
pub const RULE_SET_TEMPLATE_IDS: [&str; 3] = [
    "softwareDevelopment",
    "scientificResearch",
    "socialMedia",
];

/// The conflict axes. Two rules collide only when they name the SAME topic;
/// a rule with an empty topic declares no axis and always applies.
/// Mirrored in `ui/src/pages/agentic/agentRuleSets.ts` — the gate compares the
/// two lists so the catalogue and the resolver can never drift apart.
pub const RULE_SET_TOPICS: [&str; 17] = [
    "brand-safety",
    "cadence",
    "change-size",
    "claims",
    "disclosure",
    "format",
    "hypothesis",
    "instrument",
    "negative-results",
    "regression-guard",
    "reproducibility",
    "root-cause",
    "secrets",
    "sourcing",
    "tone",
    "uncertainty",
    "verification",
];

pub const RULE_SET_STATUSES: [&str; 3] = ["draft", "active", "archived"];
pub const RULE_KINDS: [&str; 5] = [
    "fact",
    "preference",
    "constraint",
    "workflow",
    "conditional",
];

fn schema_one() -> u32 {
    RULE_SET_SCHEMA_VERSION
}

fn yes() -> bool {
    true
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleSetRuleDoc {
    /// `rule:<uuid>` — stable across revisions so a customised rule keeps its
    /// identity, and so the same set attached at both layers dedupes by id.
    pub id: String,
    pub kind: String,
    /// Conflict axis. Empty means "no axis" — the rule always applies.
    #[serde(default)]
    pub topic: String,
    /// The position this rule takes on its axis. Same topic + same stance is a
    /// duplicate (silently deduped); same topic + different stance is a real
    /// conflict and the loser is reported, never dropped silently.
    #[serde(default)]
    pub stance: String,
    pub title: String,
    pub body: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleSetDoc {
    #[serde(default = "schema_one")]
    pub schema_version: u32,
    /// `ruleset:<uuid>`.
    pub id: String,
    pub revision: u64,
    /// One of `RULE_SET_TEMPLATE_IDS`, or `custom` for a set built from scratch.
    pub template_id: String,
    /// Edition of the built-in template this set was seeded from. `0` means
    /// unknown — a hand-built set, or one stored before provenance existed.
    /// `#[serde(default)]` IS the migration: every set written before this field
    /// existed loads as 0, and the UI re-derives the real edition from the
    /// positions the set still takes rather than assuming one.
    #[serde(default)]
    pub template_version: u32,
    pub name: String,
    pub summary: String,
    /// Lower number wins inside a layer. Defaults come from the template so two
    /// untouched built-ins never tie.
    #[serde(default)]
    pub priority: u32,
    pub rules: Vec<RuleSetRuleDoc>,
    /// Rule sets are project-scoped by definition; there is no global scope.
    pub project_id: String,
    #[serde(default = "yes")]
    pub private: bool,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

/// Assignment layers, ordered by precedence: `Agent` is more specific than
/// `Project`, so it derives first and wins every collision.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RuleSetLayer {
    Agent,
    Project,
}

impl RuleSetLayer {
    pub fn as_str(self) -> &'static str {
        match self {
            RuleSetLayer::Agent => "agent",
            RuleSetLayer::Project => "project",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedRuleSetRef {
    pub id: String,
    pub revision: u64,
    pub name: String,
    pub template_id: String,
    pub layer: RuleSetLayer,
    pub priority: u32,
    /// 0-based position in the resolved precedence order.
    pub order: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedRuleSetRule {
    pub rule: RuleSetRuleDoc,
    pub set_id: String,
    pub set_revision: u64,
    pub set_name: String,
    pub layer: RuleSetLayer,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupersededRuleSetRule {
    pub rule: RuleSetRuleDoc,
    pub set_id: String,
    pub set_revision: u64,
    pub layer: RuleSetLayer,
    /// `conflict` (same topic, opposing stance) or `duplicate` (same topic and
    /// stance, or the same rule id assigned at both layers).
    pub reason: String,
    pub winning_set_id: String,
    pub winning_rule_id: String,
    pub explanation: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleSetResolution {
    pub sets: Vec<ResolvedRuleSetRef>,
    pub applied: Vec<AppliedRuleSetRule>,
    pub superseded: Vec<SupersededRuleSetRule>,
    pub errors: Vec<String>,
}

/// Catalogue rank of a template: built-ins keep `RULE_SET_TEMPLATE_IDS` order,
/// anything else (including `custom`) sorts after them and then by name.
fn template_rank(template_id: &str) -> usize {
    RULE_SET_TEMPLATE_IDS
        .iter()
        .position(|candidate| *candidate == template_id)
        .unwrap_or(RULE_SET_TEMPLATE_IDS.len())
}

/// The total precedence order. Every component is stable data, and the final
/// component is the unique set id, so two different sets can never tie and the
/// result never depends on the order the caller happened to load them in.
fn precedence_key(layer: RuleSetLayer, doc: &RuleSetDoc) -> (RuleSetLayer, u32, usize, String, String) {
    (
        layer,
        doc.priority,
        template_rank(&doc.template_id),
        doc.template_id.clone(),
        doc.id.clone(),
    )
}

/// Everything that makes a set unusable in this project. These are hard errors,
/// not warnings: a set that fails any of them is dropped from the resolution
/// instead of being applied with a caveat.
///
/// The first check is the cross-project leak guard — it is what stops a set (and
/// its private rule bodies) from ever being read into another project's prompt.
pub fn compatibility_errors(
    project_id: &str,
    assignments: &[(RuleSetLayer, RuleSetDoc)],
) -> Vec<String> {
    let mut errors = Vec::new();
    let mut seen: BTreeMap<String, RuleSetLayer> = BTreeMap::new();
    for (layer, doc) in assignments {
        if doc.project_id != project_id {
            errors.push(format!(
                "rule set {} belongs to project {} and cannot be assigned in {}",
                doc.id, doc.project_id, project_id
            ));
        }
        if doc.status != "active" {
            errors.push(format!(
                "rule set {} must be active to be assigned; it is {}",
                doc.id, doc.status
            ));
        }
        if let Some(previous) = seen.insert(doc.id.clone(), *layer) {
            if previous == *layer {
                errors.push(format!(
                    "rule set {} is assigned twice in the {} layer",
                    doc.id,
                    layer.as_str()
                ));
            }
        }
    }
    errors.sort();
    errors.dedup();
    errors
}

/// Turn stored `(id, revision)` assignment refs into the documents to resolve,
/// agent layer first. A ref that does not resolve inside the sets handed in is
/// an error, never a silent skip — and the caller only ever hands in one
/// project's sets, which is what keeps a set from being read across projects.
pub fn collect_assignments(
    project_rule_sets: &[RuleSetDoc],
    agent_refs: &[(String, u64)],
    project_refs: &[(String, u64)],
    errors: &mut Vec<String>,
) -> Vec<(RuleSetLayer, RuleSetDoc)> {
    let mut out = Vec::new();
    for (layer, refs) in [
        (RuleSetLayer::Agent, agent_refs),
        (RuleSetLayer::Project, project_refs),
    ] {
        for (id, revision) in refs {
            match project_rule_sets
                .iter()
                .find(|doc| doc.id == *id && doc.revision == *revision)
            {
                Some(doc) => out.push((layer, doc.clone())),
                None => errors.push(format!("missing pinned rule set {id}@{revision}")),
            }
        }
    }
    out
}

/// Resolve assigned rule sets into one deterministic, conflict-free stack.
///
/// Order: agent layer before project layer; inside a layer, by priority, then
/// catalogue rank, then template id, then set id. Then, walking that order:
///
///   * a rule id already applied  -> duplicate (the same set at both layers)
///   * a topic already claimed by the same stance -> duplicate (a fork agreeing
///     with its parent)
///   * a topic already claimed by another stance  -> conflict; the earlier rule
///     wins because it comes from the more specific assignment
///   * an empty topic -> no axis, always applies
///
/// Nothing is dropped silently: every loser lands in `superseded` with the rule
/// that beat it and a sentence saying why.
pub fn resolve_rule_set_stack(
    project_id: &str,
    assignments: &[(RuleSetLayer, RuleSetDoc)],
) -> RuleSetResolution {
    let mut errors = compatibility_errors(project_id, assignments);
    let mut usable: Vec<(RuleSetLayer, RuleSetDoc)> = assignments
        .iter()
        .filter(|(_, doc)| doc.project_id == project_id && doc.status == "active")
        .cloned()
        .collect();
    usable.sort_by_key(|(layer, doc)| precedence_key(*layer, doc));
    // The same set assigned at both layers derives once, at the agent layer.
    let mut seen_sets = BTreeSet::new();
    usable.retain(|(_, doc)| seen_sets.insert(doc.id.clone()));

    let mut sets = Vec::new();
    let mut applied: Vec<AppliedRuleSetRule> = Vec::new();
    let mut superseded = Vec::new();
    // topic -> (stance, winning set id, winning rule id)
    let mut claimed: BTreeMap<String, (String, String, String)> = BTreeMap::new();
    let mut applied_rule_ids: BTreeMap<String, (String, String)> = BTreeMap::new();

    for (order, (layer, doc)) in usable.iter().enumerate() {
        sets.push(ResolvedRuleSetRef {
            id: doc.id.clone(),
            revision: doc.revision,
            name: doc.name.clone(),
            template_id: doc.template_id.clone(),
            layer: *layer,
            priority: doc.priority,
            order,
        });
        for rule in &doc.rules {
            if let Some((winning_set, winning_rule)) = applied_rule_ids.get(&rule.id) {
                superseded.push(SupersededRuleSetRule {
                    rule: rule.clone(),
                    set_id: doc.id.clone(),
                    set_revision: doc.revision,
                    layer: *layer,
                    reason: "duplicate".into(),
                    winning_set_id: winning_set.clone(),
                    winning_rule_id: winning_rule.clone(),
                    explanation: format!(
                        "{} is already applied from rule set {}.",
                        rule.title, winning_set
                    ),
                });
                continue;
            }
            if !rule.topic.is_empty() {
                if let Some((stance, winning_set, winning_rule)) = claimed.get(&rule.topic) {
                    let duplicate = *stance == rule.stance;
                    superseded.push(SupersededRuleSetRule {
                        rule: rule.clone(),
                        set_id: doc.id.clone(),
                        set_revision: doc.revision,
                        layer: *layer,
                        reason: if duplicate { "duplicate" } else { "conflict" }.into(),
                        winning_set_id: winning_set.clone(),
                        winning_rule_id: winning_rule.clone(),
                        explanation: if duplicate {
                            format!(
                                "Topic {} already says {}; rule set {} states the same position.",
                                rule.topic, stance, winning_set
                            )
                        } else {
                            format!(
                                "Topic {} is decided by the higher-precedence rule set {} ({}); this set asked for {}.",
                                rule.topic, winning_set, stance, rule.stance
                            )
                        },
                        });
                    continue;
                }
                claimed.insert(
                    rule.topic.clone(),
                    (rule.stance.clone(), doc.id.clone(), rule.id.clone()),
                );
            }
            applied_rule_ids.insert(rule.id.clone(), (doc.id.clone(), rule.id.clone()));
            applied.push(AppliedRuleSetRule {
                rule: rule.clone(),
                set_id: doc.id.clone(),
                set_revision: doc.revision,
                set_name: doc.name.clone(),
                layer: *layer,
            });
        }
    }

    errors.sort();
    errors.dedup();
    RuleSetResolution {
        sets,
        applied,
        superseded,
        errors,
    }
}

/// Shape validation. Storage-level checks (uuid ids, revision conflicts) stay in
/// `personal_agents.rs`; this is what the editor can check before saving.
pub fn rule_set_validation_errors(doc: &RuleSetDoc) -> Vec<String> {
    let mut errors = Vec::new();
    if doc.schema_version != RULE_SET_SCHEMA_VERSION {
        errors.push("rule set schemaVersion must be 1".into());
    }
    if doc.revision == 0 {
        errors.push("rule set revision must be positive".into());
    }
    if !doc.id.starts_with("ruleset:") {
        errors.push("rule set id must start with ruleset:".into());
    }
    if doc.name.trim().is_empty() {
        errors.push("rule set name is required".into());
    }
    if doc.project_id.trim().is_empty() {
        errors.push("rule sets are project-scoped and need a project id".into());
    }
    if !RULE_SET_STATUSES.contains(&doc.status.as_str()) {
        errors.push(format!("invalid rule set status {}", doc.status));
    }
    if doc.status == "active" {
        if doc.summary.trim().is_empty() {
            errors.push("summary is required before a rule set can be activated".into());
        }
        if doc.rules.is_empty() {
            errors.push("an active rule set needs at least one rule".into());
        }
    }
    let mut ids = BTreeSet::new();
    for rule in &doc.rules {
        if !rule.id.starts_with("rule:") {
            errors.push(format!("rule id {} must start with rule:", rule.id));
        }
        if !ids.insert(rule.id.as_str()) {
            errors.push(format!("duplicate rule id {} inside the set", rule.id));
        }
        if !RULE_KINDS.contains(&rule.kind.as_str()) {
            errors.push(format!("invalid rule kind {}", rule.kind));
        }
        if rule.title.trim().is_empty() || rule.body.trim().is_empty() {
            errors.push(format!("rule {} needs a title and a body", rule.id));
        }
        if !rule.topic.is_empty() && !RULE_SET_TOPICS.contains(&rule.topic.as_str()) {
            errors.push(format!(
                "rule {} uses unknown conflict topic {}",
                rule.id, rule.topic
            ));
        }
        if !rule.topic.is_empty() && rule.stance.trim().is_empty() {
            errors.push(format!(
                "rule {} names topic {} but takes no stance on it",
                rule.id, rule.topic
            ));
        }
    }
    errors.sort();
    errors.dedup();
    errors
}

/// Only sets belonging to this project may be seen here. This is the single
/// place the UI and the resolver agree on what "visible here" means, and it is
/// the cross-project guard: a set is never even a candidate elsewhere.
///
/// EVERY revision is kept. An assignment pins `(id, revision)`, so collapsing to
/// the newest here would silently un-pin a project that deliberately stayed on
/// an older version of a rule set.
pub fn visible_rule_sets(sets: &[RuleSetDoc], project_id: &str) -> Vec<RuleSetDoc> {
    if project_id.is_empty() {
        return Vec::new();
    }
    sets.iter()
        .filter(|doc| doc.project_id == project_id)
        .cloned()
        .collect()
}

/// The newest revision of each of this project's sets — what the editor lists
/// and what a fresh assignment pins to.
pub fn latest_rule_sets(sets: &[RuleSetDoc], project_id: &str) -> Vec<RuleSetDoc> {
    let mut latest: BTreeMap<String, RuleSetDoc> = BTreeMap::new();
    for doc in visible_rule_sets(sets, project_id) {
        let keep = latest
            .get(&doc.id)
            .is_none_or(|existing| existing.revision < doc.revision);
        if keep {
            latest.insert(doc.id.clone(), doc);
        }
    }
    latest.into_values().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(id: &str, topic: &str, stance: &str) -> RuleSetRuleDoc {
        RuleSetRuleDoc {
            id: format!("rule:{id}"),
            kind: "constraint".into(),
            topic: topic.into(),
            stance: stance.into(),
            title: format!("{topic}/{stance}"),
            body: format!("body for {id}"),
        }
    }

    fn set(id: &str, template: &str, priority: u32, rules: Vec<RuleSetRuleDoc>) -> RuleSetDoc {
        RuleSetDoc {
            schema_version: 1,
            id: format!("ruleset:{id}"),
            revision: 1,
            template_id: template.into(),
            template_version: 1,
            name: id.into(),
            summary: "summary".into(),
            priority,
            rules,
            project_id: "proj-a".into(),
            private: true,
            status: "active".into(),
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
        }
    }

    #[test]
    fn agent_layer_beats_project_layer_on_a_shared_topic() {
        let dev = set(
            "dev",
            "softwareDevelopment",
            10,
            vec![rule("a", "tone", "plain-technical")],
        );
        let social = set(
            "social",
            "socialMedia",
            30,
            vec![rule("b", "tone", "hook-led-conversational")],
        );
        // Project layer listed FIRST on purpose: input order must not matter.
        let resolved = resolve_rule_set_stack(
            "proj-a",
            &[
                (RuleSetLayer::Project, dev.clone()),
                (RuleSetLayer::Agent, social.clone()),
            ],
        );
        assert_eq!(resolved.applied.len(), 1);
        assert_eq!(resolved.applied[0].set_id, social.id);
        assert_eq!(resolved.superseded.len(), 1);
        assert_eq!(resolved.superseded[0].reason, "conflict");
        assert_eq!(resolved.superseded[0].winning_set_id, social.id);
    }

    #[test]
    fn inside_a_layer_priority_then_catalogue_order_decides() {
        let science = set(
            "sci",
            "scientificResearch",
            20,
            vec![rule("a", "sourcing", "cite-primary-sources")],
        );
        let social = set(
            "soc",
            "socialMedia",
            20,
            vec![rule("b", "sourcing", "link-source-once")],
        );
        let resolved = resolve_rule_set_stack(
            "proj-a",
            &[
                (RuleSetLayer::Project, social),
                (RuleSetLayer::Project, science.clone()),
            ],
        );
        // Equal priority -> catalogue rank breaks the tie, deterministically.
        assert_eq!(resolved.applied[0].set_id, science.id);
        assert_eq!(resolved.superseded[0].reason, "conflict");
    }

    #[test]
    fn the_order_the_caller_loads_sets_in_never_changes_the_result() {
        let a = set("a", "custom", 5, vec![rule("x", "tone", "one")]);
        let b = set("b", "custom", 5, vec![rule("y", "tone", "two")]);
        let forward = resolve_rule_set_stack(
            "proj-a",
            &[(RuleSetLayer::Project, a.clone()), (RuleSetLayer::Project, b.clone())],
        );
        let reverse = resolve_rule_set_stack(
            "proj-a",
            &[(RuleSetLayer::Project, b), (RuleSetLayer::Project, a)],
        );
        assert_eq!(forward, reverse);
    }

    #[test]
    fn a_fork_that_agrees_with_its_parent_dedupes_instead_of_conflicting() {
        let parent = set(
            "parent",
            "softwareDevelopment",
            10,
            vec![rule("a", "verification", "execute-before-claiming")],
        );
        let fork = set(
            "fork",
            "custom",
            10,
            vec![rule("b", "verification", "execute-before-claiming")],
        );
        let resolved =
            resolve_rule_set_stack("proj-a", &[(RuleSetLayer::Project, parent), (RuleSetLayer::Project, fork)]);
        assert_eq!(resolved.applied.len(), 1);
        assert_eq!(resolved.superseded.len(), 1);
        assert_eq!(resolved.superseded[0].reason, "duplicate");
    }

    #[test]
    fn rules_without_a_topic_never_conflict() {
        let a = set("a", "custom", 1, vec![rule("x", "", "")]);
        let mut b = set("b", "custom", 2, vec![rule("y", "", "")]);
        b.rules[0].title = "second".into();
        let resolved =
            resolve_rule_set_stack("proj-a", &[(RuleSetLayer::Project, a), (RuleSetLayer::Project, b)]);
        assert_eq!(resolved.applied.len(), 2);
        assert!(resolved.superseded.is_empty());
    }

    #[test]
    fn a_set_from_another_project_is_refused_not_merged() {
        let mut foreign = set("foreign", "custom", 1, vec![rule("x", "tone", "loud")]);
        foreign.project_id = "proj-b".into();
        let resolved = resolve_rule_set_stack("proj-a", &[(RuleSetLayer::Agent, foreign)]);
        assert!(resolved.applied.is_empty());
        assert!(resolved.sets.is_empty());
        assert!(resolved.errors.iter().any(|e| e.contains("belongs to project proj-b")));
    }

    #[test]
    fn a_draft_set_is_refused() {
        let mut draft = set("draft", "custom", 1, vec![rule("x", "tone", "loud")]);
        draft.status = "draft".into();
        let resolved = resolve_rule_set_stack("proj-a", &[(RuleSetLayer::Project, draft)]);
        assert!(resolved.applied.is_empty());
        assert!(resolved.errors.iter().any(|e| e.contains("must be active")));
    }

    #[test]
    fn the_same_set_at_both_layers_derives_once_at_the_agent_layer() {
        let both = set("both", "custom", 1, vec![rule("x", "tone", "loud")]);
        let resolved = resolve_rule_set_stack(
            "proj-a",
            &[(RuleSetLayer::Project, both.clone()), (RuleSetLayer::Agent, both)],
        );
        assert_eq!(resolved.sets.len(), 1);
        assert_eq!(resolved.sets[0].layer, RuleSetLayer::Agent);
        assert!(resolved.superseded.is_empty());
        assert!(resolved.errors.is_empty());
    }

    #[test]
    fn visible_hides_other_projects_but_keeps_every_revision_pinnable() {
        let mut old = set("a", "custom", 1, vec![]);
        old.revision = 1;
        let mut new = old.clone();
        new.revision = 3;
        let mut foreign = set("b", "custom", 1, vec![]);
        foreign.project_id = "proj-b".into();
        let all = [old, new, foreign];
        let visible = visible_rule_sets(&all, "proj-a");
        assert_eq!(visible.len(), 2, "an older pinned revision stays resolvable");
        assert!(visible.iter().all(|doc| doc.project_id == "proj-a"));
        let latest = latest_rule_sets(&all, "proj-a");
        assert_eq!(latest.len(), 1);
        assert_eq!(latest[0].revision, 3);
        assert!(visible_rule_sets(&all, "").is_empty());
        assert!(latest_rule_sets(&all, "").is_empty());
    }

    #[test]
    fn validation_catches_unknown_topics_and_stanceless_axes() {
        let mut doc = set("a", "custom", 1, vec![rule("x", "tone", "")]);
        doc.rules.push(RuleSetRuleDoc {
            id: "rule:y".into(),
            kind: "constraint".into(),
            topic: "not-a-topic".into(),
            stance: "whatever".into(),
            title: "t".into(),
            body: "b".into(),
        });
        let errors = rule_set_validation_errors(&doc);
        assert!(errors.iter().any(|e| e.contains("takes no stance")));
        assert!(errors.iter().any(|e| e.contains("unknown conflict topic")));
    }
}
