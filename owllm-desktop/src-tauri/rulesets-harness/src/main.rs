//! Executed regression proof for project-scoped rule-set profiles.
//!
//! The ordering and conflict rules live in `personal_agent_rule_sets.rs` and run
//! here as `cargo test`. This binary drives those same functions through the
//! SEQUENCES the app puts them through — assign at two layers, restart, pin an
//! old revision, unassign, and work in a second project — because the failures
//! that matter are sequencing failures: the rules can be right while a reload
//! or a neighbouring project quietly changes what an agent is told.
//!
//! The store below mirrors `<user_data>/personal-agents/projects/<hash>/store.enc`:
//! one encrypted scope per project, holding that project's rule sets and the
//! project config that assigns them. Serialising it to JSON and reading it back
//! is exactly the restart the user performs by closing the app.
//!
//! Two modes:
//!   cargo run --quiet                       -> run the scenarios, print PASS lines
//!   cargo run --quiet -- --resolve <file>   -> resolve one assignment payload
//!                                              (the gate feeds it the REAL
//!                                              templates from agentRuleSets.ts)

#[path = "../../src/personal_agent_rule_sets.rs"]
#[allow(dead_code)]
mod rule_sets;

use std::collections::BTreeMap;

use rule_sets::{
    collect_assignments, latest_rule_sets, resolve_rule_set_stack, rule_set_validation_errors,
    visible_rule_sets, RuleSetDoc, RuleSetLayer, RuleSetResolution, RuleSetRuleDoc,
};
use serde::{Deserialize, Serialize};

// ------------------------------------------------------------------ the store

/// One project's encrypted scope, reduced to the two things rule sets touch.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectScope {
    #[serde(default)]
    rule_sets: Vec<RuleSetDoc>,
    /// `ProjectAgentConfigDoc.ruleSetRefs` — the project layer.
    #[serde(default)]
    rule_set_refs: Vec<(String, u64)>,
    /// `profileOverrides[profileId].ruleSetRefs` — the agent layer.
    #[serde(default)]
    agent_rule_set_refs: BTreeMap<String, Vec<(String, u64)>>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Repo {
    projects: BTreeMap<String, ProjectScope>,
}

impl Repo {
    fn scope(&mut self, project_id: &str) -> &mut ProjectScope {
        self.projects.entry(project_id.to_string()).or_default()
    }

    /// Append-only by revision, like `save_rule_set_with`.
    fn save_set(&mut self, doc: &RuleSetDoc) -> RuleSetDoc {
        let scope = self.scope(&doc.project_id.clone());
        let next = scope
            .rule_sets
            .iter()
            .filter(|existing| existing.id == doc.id)
            .map(|existing| existing.revision)
            .max()
            .map_or(1, |revision| revision + 1);
        let mut stored = doc.clone();
        stored.revision = next;
        scope.rule_sets.push(stored.clone());
        stored
    }

    fn assign_project(&mut self, project_id: &str, set: &RuleSetDoc) {
        self.scope(project_id)
            .rule_set_refs
            .push((set.id.clone(), set.revision));
    }

    fn assign_agent(&mut self, project_id: &str, profile_id: &str, set: &RuleSetDoc) {
        self.scope(project_id)
            .agent_rule_set_refs
            .entry(profile_id.to_string())
            .or_default()
            .push((set.id.clone(), set.revision));
    }

    fn unassign_project(&mut self, project_id: &str, set_id: &str) {
        self.scope(project_id)
            .rule_set_refs
            .retain(|(id, _)| id != set_id);
    }

    /// The app's read path: only this project's scope is ever loaded.
    fn resolve(&self, project_id: &str, profile_id: &str) -> RuleSetResolution {
        let Some(scope) = self.projects.get(project_id) else {
            return RuleSetResolution::default();
        };
        let visible = visible_rule_sets(&scope.rule_sets, project_id);
        let mut errors = Vec::new();
        let agent = scope
            .agent_rule_set_refs
            .get(profile_id)
            .cloned()
            .unwrap_or_default();
        let assignments =
            collect_assignments(&visible, &agent, &scope.rule_set_refs, &mut errors);
        let mut resolution = resolve_rule_set_stack(project_id, &assignments);
        resolution.errors.extend(errors);
        resolution.errors.sort();
        resolution.errors.dedup();
        resolution
    }

    /// Close and reopen the app.
    fn restart(&self) -> Repo {
        serde_json::from_str(&serde_json::to_string(self).expect("serialise store"))
            .expect("reload store")
    }
}

// ------------------------------------------------------------------- fixtures

fn rule(kind: &str, topic: &str, stance: &str, title: &str) -> RuleSetRuleDoc {
    RuleSetRuleDoc {
        id: format!("rule:{topic}-{stance}"),
        kind: kind.into(),
        topic: topic.into(),
        stance: stance.into(),
        title: title.into(),
        body: format!("{title} — body."),
    }
}

fn set(id: &str, project: &str, template: &str, priority: u32, rules: Vec<RuleSetRuleDoc>) -> RuleSetDoc {
    RuleSetDoc {
        schema_version: 1,
        id: format!("ruleset:{id}"),
        revision: 1,
        template_id: template.into(),
        name: id.into(),
        summary: format!("{id} summary"),
        priority,
        rules,
        project_id: project.into(),
        private: true,
        status: "active".into(),
        created_at: "2026-01-01T00:00:00Z".into(),
        updated_at: "2026-01-01T00:00:00Z".into(),
    }
}

fn dev_set(project: &str) -> RuleSetDoc {
    set(
        "dev",
        project,
        "softwareDevelopment",
        10,
        vec![
            rule("constraint", "root-cause", "prove-mechanism-then-fix", "Prove the mechanism"),
            rule("preference", "sourcing", "cite-code-locations", "Cite file and line"),
            rule("preference", "tone", "plain-technical", "Report plainly"),
        ],
    )
}

fn science_set(project: &str) -> RuleSetDoc {
    set(
        "science",
        project,
        "scientificResearch",
        20,
        vec![
            rule("workflow", "hypothesis", "state-falsifier-first", "Name the falsifier"),
            rule("constraint", "sourcing", "cite-primary-sources", "Cite primary sources"),
            rule("preference", "tone", "precise-and-hedged", "Hedge honestly"),
        ],
    )
}

fn social_set(project: &str) -> RuleSetDoc {
    set(
        "social",
        project,
        "socialMedia",
        30,
        vec![
            rule("constraint", "disclosure", "label-paid-and-synthetic", "Disclose the money"),
            rule("preference", "sourcing", "attribute-once-in-post", "Attribute in the post"),
            rule("preference", "tone", "hook-led-conversational", "Lead with the hook"),
        ],
    )
}

// ------------------------------------------------------------------ scenarios

fn topics(resolution: &RuleSetResolution) -> Vec<String> {
    resolution
        .applied
        .iter()
        .map(|entry| format!("{}={}", entry.rule.topic, entry.rule.stance))
        .collect()
}

/// What the code did BEFORE the precedence layer existed: concatenate whatever
/// was attached, in load order. Kept here so the numbers below mean something —
/// it must reproduce the double-counting and the load-order dependence.
fn naive_concat(assignments: &[(RuleSetLayer, RuleSetDoc)]) -> Vec<String> {
    assignments
        .iter()
        .flat_map(|(_, doc)| doc.rules.iter())
        .map(|rule| format!("{}={}", rule.topic, rule.stance))
        .collect()
}

fn control_pre_fix_behaviour_reproduces_the_bug() {
    let dev = dev_set("proj-a");
    let social = social_set("proj-a");
    let forward = naive_concat(&[
        (RuleSetLayer::Project, dev.clone()),
        (RuleSetLayer::Agent, social.clone()),
    ]);
    let reverse = naive_concat(&[
        (RuleSetLayer::Agent, social.clone()),
        (RuleSetLayer::Project, dev.clone()),
    ]);
    // Two different prompts from the same assignment, and BOTH tone rules in.
    assert_ne!(forward, reverse, "naive concat should depend on load order");
    assert_eq!(
        forward.iter().filter(|t| t.starts_with("tone=")).count(),
        2,
        "naive concat should contradict itself on tone"
    );
    // The real resolver fixes exactly that.
    let resolved = resolve_rule_set_stack(
        "proj-a",
        &[(RuleSetLayer::Project, dev), (RuleSetLayer::Agent, social)],
    );
    assert_eq!(
        resolved.applied.iter().filter(|e| e.rule.topic == "tone").count(),
        1
    );
}

fn project_and_agent_layers_compose() {
    let mut repo = Repo::default();
    let dev = repo.save_set(&dev_set("proj-a"));
    let social = repo.save_set(&social_set("proj-a"));
    repo.assign_project("proj-a", &dev);
    repo.assign_agent("proj-a", "agent:one", &social);
    let resolved = repo.resolve("proj-a", "agent:one");
    assert_eq!(resolved.sets.len(), 2);
    assert_eq!(resolved.sets[0].layer, RuleSetLayer::Agent);
    // Non-overlapping topics from both sets survive.
    let applied = topics(&resolved);
    assert!(applied.contains(&"root-cause=prove-mechanism-then-fix".to_string()));
    assert!(applied.contains(&"disclosure=label-paid-and-synthetic".to_string()));
    // The two axes they disagree on resolve once each, to the agent layer.
    assert!(applied.contains(&"tone=hook-led-conversational".to_string()));
    assert!(applied.contains(&"sourcing=attribute-once-in-post".to_string()));
    assert_eq!(resolved.superseded.len(), 2);
    assert!(resolved.superseded.iter().all(|s| s.reason == "conflict"));
    assert!(resolved.errors.is_empty());
}

fn an_agent_without_its_own_assignment_gets_the_project_stack() {
    let mut repo = Repo::default();
    let dev = repo.save_set(&dev_set("proj-a"));
    let social = repo.save_set(&social_set("proj-a"));
    repo.assign_project("proj-a", &dev);
    repo.assign_agent("proj-a", "agent:one", &social);
    let other = repo.resolve("proj-a", "agent:two");
    assert_eq!(other.sets.len(), 1);
    assert_eq!(other.sets[0].name, "dev");
    assert!(topics(&other).contains(&"tone=plain-technical".to_string()));
}

fn three_templates_combine_with_one_winner_per_topic() {
    let mut repo = Repo::default();
    let dev = repo.save_set(&dev_set("proj-a"));
    let science = repo.save_set(&science_set("proj-a"));
    let social = repo.save_set(&social_set("proj-a"));
    for doc in [&dev, &science, &social] {
        repo.assign_project("proj-a", doc);
    }
    let resolved = repo.resolve("proj-a", "agent:one");
    let applied = topics(&resolved);
    let mut seen: Vec<&str> = applied.iter().map(|t| t.split('=').next().unwrap()).collect();
    seen.sort();
    let unique = {
        let mut copy = seen.clone();
        copy.dedup();
        copy
    };
    assert_eq!(seen, unique, "a topic must be decided exactly once");
    // Priority order: dev(10) < science(20) < social(30).
    assert!(applied.contains(&"tone=plain-technical".to_string()));
    assert!(applied.contains(&"sourcing=cite-code-locations".to_string()));
    assert_eq!(resolved.superseded.len(), 4);
    // Every loser names the winner rather than vanishing.
    assert!(resolved
        .superseded
        .iter()
        .all(|s| !s.winning_set_id.is_empty() && !s.explanation.is_empty()));
}

fn restart_reloads_the_same_stack() {
    let mut repo = Repo::default();
    let dev = repo.save_set(&dev_set("proj-a"));
    let social = repo.save_set(&social_set("proj-a"));
    repo.assign_project("proj-a", &dev);
    repo.assign_agent("proj-a", "agent:one", &social);
    let before = repo.resolve("proj-a", "agent:one");
    let after = repo.restart().resolve("proj-a", "agent:one");
    assert_eq!(before, after, "the stack must survive a restart byte for byte");
}

fn a_second_project_sees_none_of_it() {
    let mut repo = Repo::default();
    let a_dev = repo.save_set(&dev_set("proj-a"));
    repo.assign_project("proj-a", &a_dev);
    let b_social = repo.save_set(&social_set("proj-b"));
    repo.assign_project("proj-b", &b_social);

    let a = repo.resolve("proj-a", "agent:one");
    let b = repo.resolve("proj-b", "agent:one");
    assert_eq!(a.sets.len(), 1);
    assert_eq!(b.sets.len(), 1);
    assert!(topics(&a).contains(&"tone=plain-technical".to_string()));
    assert!(topics(&b).contains(&"tone=hook-led-conversational".to_string()));
    // Project A's rule bodies never appear in project B's stack, and vice versa.
    let b_bodies: Vec<_> = b.applied.iter().map(|e| e.rule.body.clone()).collect();
    assert!(a
        .applied
        .iter()
        .all(|entry| !b_bodies.contains(&entry.rule.body)));

    // Even a hand-forged assignment of A's set inside B is refused, not merged.
    repo.scope("proj-b")
        .rule_set_refs
        .push((a_dev.id.clone(), a_dev.revision));
    let forged = repo.resolve("proj-b", "agent:one");
    assert_eq!(forged.sets.len(), 1, "the foreign set must not be applied");
    assert!(forged
        .errors
        .iter()
        .any(|e| e.contains("missing pinned rule set")));
}

fn pinning_an_older_revision_keeps_the_old_rules() {
    let mut repo = Repo::default();
    let v1 = repo.save_set(&dev_set("proj-a"));
    repo.assign_project("proj-a", &v1);
    let mut edited = v1.clone();
    edited.rules[2].stance = "loud".into();
    edited.rules[2].body = "Rewritten in revision 2.".into();
    let v2 = repo.save_set(&edited);
    assert_eq!(v2.revision, 2);

    // The pinned ref still says @1, so the stack keeps revision 1's text.
    let pinned = repo.resolve("proj-a", "agent:one");
    assert_eq!(pinned.sets[0].revision, 1);
    assert!(topics(&pinned).contains(&"tone=plain-technical".to_string()));
    // ...while the editor offers only the newest revision to assign next.
    let listed = latest_rule_sets(&repo.projects["proj-a"].rule_sets, "proj-a");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].revision, 2);

    // Moving the pin to @2 is what adopts the edit — versioning is explicit.
    repo.unassign_project("proj-a", &v2.id);
    repo.assign_project("proj-a", &v2);
    let upgraded = repo.resolve("proj-a", "agent:one");
    assert_eq!(upgraded.sets[0].revision, 2);
    assert!(topics(&upgraded).contains(&"tone=loud".to_string()));
}

fn unassigning_removes_the_rules_and_survives_restart() {
    let mut repo = Repo::default();
    let dev = repo.save_set(&dev_set("proj-a"));
    repo.assign_project("proj-a", &dev);
    assert_eq!(repo.resolve("proj-a", "agent:one").applied.len(), 3);
    repo.unassign_project("proj-a", &dev.id);
    let after = repo.restart().resolve("proj-a", "agent:one");
    assert!(after.applied.is_empty());
    assert!(after.sets.is_empty());
    // The set itself is still there to re-assign — unassigning is not deleting.
    assert_eq!(repo.restart().projects["proj-a"].rule_sets.len(), 1);
}

fn a_fork_of_a_template_dedupes_instead_of_double_counting() {
    let mut repo = Repo::default();
    let dev = repo.save_set(&dev_set("proj-a"));
    let mut fork = dev.clone();
    fork.id = "ruleset:dev-fork".into();
    fork.template_id = "custom".into();
    fork.name = "dev (copy)".into();
    fork.revision = 0;
    // A fork keeps the parent's rule ids, so the two dedupe by id.
    let fork = repo.save_set(&fork);
    repo.assign_project("proj-a", &dev);
    repo.assign_agent("proj-a", "agent:one", &fork);
    let resolved = repo.resolve("proj-a", "agent:one");
    assert_eq!(resolved.applied.len(), 3, "the same rules must apply once");
    assert!(resolved.superseded.iter().all(|s| s.reason == "duplicate"));
}

fn an_invalid_set_is_reported_not_silently_accepted() {
    let mut broken = dev_set("proj-a");
    broken.rules[0].topic = "not-an-axis".into();
    broken.rules.push(RuleSetRuleDoc {
        id: "rule:no-body".into(),
        kind: "constraint".into(),
        topic: String::new(),
        stance: String::new(),
        title: "Empty".into(),
        body: "   ".into(),
    });
    let errors = rule_set_validation_errors(&broken);
    assert!(errors.iter().any(|e| e.contains("unknown conflict topic")));
    assert!(errors.iter().any(|e| e.contains("needs a title and a body")));
}

// ----------------------------------------------------------------- resolve io

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveRequest {
    project_id: String,
    #[serde(default)]
    agent: Vec<RuleSetDoc>,
    #[serde(default)]
    project: Vec<RuleSetDoc>,
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--resolve") {
        let path = args.get(1).expect("--resolve needs a file path");
        let raw = std::fs::read_to_string(path).expect("read resolve request");
        let request: ResolveRequest = serde_json::from_str(&raw).expect("parse resolve request");
        let assignments: Vec<(RuleSetLayer, RuleSetDoc)> = request
            .agent
            .into_iter()
            .map(|doc| (RuleSetLayer::Agent, doc))
            .chain(
                request
                    .project
                    .into_iter()
                    .map(|doc| (RuleSetLayer::Project, doc)),
            )
            .collect();
        let resolution = resolve_rule_set_stack(&request.project_id, &assignments);
        println!(
            "{}",
            serde_json::to_string(&resolution).expect("serialise resolution")
        );
        return;
    }

    let scenarios: Vec<(&str, fn())> = vec![
        (
            "control_pre_fix_behaviour_reproduces_the_bug",
            control_pre_fix_behaviour_reproduces_the_bug as fn(),
        ),
        ("project_and_agent_layers_compose", project_and_agent_layers_compose),
        (
            "an_agent_without_its_own_assignment_gets_the_project_stack",
            an_agent_without_its_own_assignment_gets_the_project_stack,
        ),
        (
            "three_templates_combine_with_one_winner_per_topic",
            three_templates_combine_with_one_winner_per_topic,
        ),
        ("restart_reloads_the_same_stack", restart_reloads_the_same_stack),
        ("a_second_project_sees_none_of_it", a_second_project_sees_none_of_it),
        (
            "pinning_an_older_revision_keeps_the_old_rules",
            pinning_an_older_revision_keeps_the_old_rules,
        ),
        (
            "unassigning_removes_the_rules_and_survives_restart",
            unassigning_removes_the_rules_and_survives_restart,
        ),
        (
            "a_fork_of_a_template_dedupes_instead_of_double_counting",
            a_fork_of_a_template_dedupes_instead_of_double_counting,
        ),
        (
            "an_invalid_set_is_reported_not_silently_accepted",
            an_invalid_set_is_reported_not_silently_accepted,
        ),
    ];
    for (name, scenario) in scenarios {
        scenario();
        println!("PASS {name}");
    }
}
