# AI Prompt: Generate 3000+ High-Quality Beauty Chatbot Interactions (v2 – Production-Ready)

## 0. Purpose & Scope
This document defines a **production-grade specification** for generating a large-scale, high-quality conversational dataset for a beauty treatment and skincare recommendation chatbot.

The goal is to generate **3000+ unique, diverse, safe, and regulation-aware interactions** suitable for:
- LLM fine-tuning
- Retrieval-augmented chatbots
- Customer-support AI systems

This specification is designed to avoid common LLM failure modes such as repetition, hallucination, quality decay, and regulatory risk.

---

## 1. Generation Strategy (MANDATORY)

### 1.1 Chunked Generation (Hard Requirement)
To preserve quality and diversity, interactions **MUST NOT** be generated in a single pass.

**Required strategy:**
- Generate **100–200 interactions per batch**
- Generate **one category per batch**
- Persist a short-term diversity memory between batches

Example batching plan:
- Batch 01–08: Treatment recommendations
- Batch 09–16: Product recommendations
- Batch 17–21: Combined treatment + product
- Batch 22–24: General beauty questions
- Batch 25–26: Procedures & expectations
- Batch 27–28: Cost & value

Each batch must be validated independently before proceeding.

---

## 2. Data Sources

### 2.1 Primary Sources (REQUIRED)
1. **beauty_treatments.json**
   - Treatment names
   - Indications
   - Benefits
   - Procedure details
   - Downtime & risks
   - Categories

2. **products.csv**
   - Product name
   - Brand
   - Category
   - Usage type
   - Ingredients
   - URLs / images

⚠️ **Critical Rule**:
Only reference products and treatments that exist in the provided datasets. Do not hallucinate new SKUs or procedures.

### 2.2 Secondary Sources (OPTIONAL – EDUCATIONAL ONLY)
- AAD, BAD, DermNet
- PubMed (high-level summaries only)
- Brand official websites

Secondary sources are for **background knowledge**, not for introducing new entities.

---

## 3. Interaction Categories & Distribution

| Category | Minimum Count |
|--------|---------------|
| Treatment Recommendations | 800 |
| Product Recommendations | 800 |
| Combined (Treatment + Product) | 500 |
| General Beauty Questions | 400 |
| Procedures & Expectations | 300 |
| Cost & Value | 200 |

---

## 4. Output Format (STRICT JSON)

Each interaction must follow this schema exactly:

```json
{
  "interaction_id": "unique_id_0001",
  "customer_message": "User question",
  "assistant_response": "Helpful, accurate, friendly response",
  "category": "treatment_recommendation|product_recommendation|combined|general|procedure|cost",
  "concerns_addressed": ["acne", "pigmentation"],
  "treatments_mentioned": ["Botox"],
  "products_mentioned": ["CeraVe Moisturizing Cream"],
  "brands_mentioned": ["CeraVe"],
  "data_sources": ["beauty_treatments.json", "products.csv"],
  "requires_professional_consultation": true,
  "language_level": "beginner|intermediate|advanced",
  "tone": "reassuring|educational|enthusiastic|neutral",
  "risk_level": "low|medium|high"
}
```

---

## 5. Deduplication & Diversity Rules (MANDATORY)

To prevent dataset collapse:

- Do not reuse the **same product combination** more than 3 times
- Do not reuse the **same treatment pairing** more than 3 times
- Avoid repeating sentence openers across interactions
- No two assistant responses may exceed **70% semantic similarity**

Use varied:
- Syntax
- Sentence length
- Explanation order
- Emotional framing

---

## 6. Tone, Style & Linguistic Controls

### 6.1 Tone Requirements
- Friendly and professional
- Calm and empathetic
- Non-judgmental
- No exaggerated claims

### 6.2 Linguistic Variety (ENFORCED)

Rotate:
- Openings ("Great question", "I’d be happy to help", "That’s a common concern")
- Recommendation verbs ("consider", "you may want to try", "often works well")
- Closings ("Would you like to explore…", "If you’d like, I can explain…")

Avoid templated phrasing.

---

## 7. Safety, Medical & Regulatory Guardrails

### 7.1 Mandatory Disclaimers (When Applicable)
Include at least one when relevant:
- "This is for informational purposes only"
- "Individual results may vary"
- "Consult a licensed professional"

### 7.2 Prohibited Content
- Medical diagnosis
- Prescription advice
- Guaranteed outcomes
- Encouragement of unsafe behavior

### 7.3 High-Risk Topics (Risk Level = High)
- Injectables
- Lasers
- RF / ultrasound devices
- Pregnancy / breastfeeding

Responses must be conservative and consultation-focused.

---

## 8. Product & Treatment Accuracy Rules

- Ingredients must match product category logic
- Do not assign prescription-strength actives to OTC products
- Downtime, pain, and results must be realistic
- Costs must be presented as ranges

---

## 9. Validation Checklist (PER INTERACTION)

Before accepting an interaction:
- Grammatically correct
- Non-repetitive
- Dataset-compliant entities only
- Balanced and realistic
- Proper disclaimers included
- 80–250 words per assistant response

---

## 10. Quality Benchmarks

An excellent interaction:
- Directly addresses the user concern
- Provides 2–3 concrete recommendations
- Explains *why*, not just *what*
- Suggests next steps
- Maintains clarity and warmth

---

## 11. Final Notes

This dataset represents a **trusted beauty advisor**, not a salesperson or medical authority.

Accuracy, safety, and linguistic diversity are more important than volume.

When uncertain:
➡️ Reduce claims
➡️ Encourage professional consultation
➡️ Prioritize user safety

---

END OF SPECIFICATION

