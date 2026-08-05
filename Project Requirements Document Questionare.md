# PRD Question Bank — OS Concepts Simulator

Answer these section by section. You don't need polished prose — bullet points and half-thoughts are enough to turn into a real PRD later. Sections are ordered roughly in the order you'd actually want to think through them.

---

## 1. Core Vision

- In one sentence, what does this simulator let someone _do_ that they can't easily do with a textbook diagram or a static video?
	- This simulator allows a teacher to easily explain topics to students, that require a little bit more than just 2D tables, for example if in a class, the teacher is teaching
- Who is the primary user? (Yourself revising for exams? Juniors at your college? Anyone learning OS online? Your professor's class?)
	- a professor would use this to demonstrate hard to illustrate topics when teaching their class
- Is this meant to be a **teaching aid** (explains concepts step by step), a **practice/testing tool** (quizzes them), or a **sandbox** (lets them freely experiment and see results) — or some mix of all three?
	- teaching aid, with a practice and testing feature as well
- What's the "hook" — the one feature that would make someone screenshot it and send it to a classmate?
	- its hook is its ability to visualise topics that would be hard to understand with a 2D table or image
- Is there an existing tool you're consciously trying to be better than (e.g. OS scheduling visualizers already on GitHub)? What do they get wrong or leave out?
	- not that i know of

## 2. Topics Covered

> **✏️ Manually editable — this is the list you'll keep extending.** Format suggestion: Topic name → sub-concepts → status.

| Topic             | Sub-concepts to simulate                                                           | Status      |
| ----------------- | ---------------------------------------------------------------------------------- | ----------- |
| CPU Scheduling    | FCFS, SJF, Priority, Round Robin, Multilevel Queue                                 | Not started |
| Paging            | Page tables, page faults, TLB, page replacement (FIFO/LRU/Optimal)                 | Not started |
| Memory Management | Contiguous allocation, fragmentation, segmentation                                 | Not started |
| Deadlocks         | Causes (Coffman conditions), detection, avoidance (Banker's algorithm), prevention | Not started |
| _(add more here)_ |                                                                                    |             |

- For each topic, do you want the **same interaction pattern** reused (e.g. "enter inputs → step through → see Gantt chart / table → see metrics"), or should each topic get a custom-designed interaction?
- Is there a natural **sequence/dependency** between topics (e.g. should "Memory Management" unlock before "Paging" since paging builds on it), or is every topic standalone and jumpable?
- Which topic are you building **first**, and why that one (simplest to prototype? most exam-relevant? most visually satisfying)?

## 3. Per-Topic Feature Depth

For whichever topic you're speccing right now (start with your first one):

- What inputs does the user provide? (e.g. for CPU scheduling: process list with arrival time, burst time, priority, quantum)
- What does the simulator compute/show? (Gantt chart, waiting time, turnaround time, throughput, per-process breakdown?)
- Does it run as one instant calculation, or does the user **step through it** (tick-by-tick / event-by-event) like a debugger?
- Can the user **pause, rewind, replay, or change speed** mid-simulation?
- Are there **preset scenarios** (e.g. "classic starvation example") vs. fully custom user-entered inputs?
- For "how deadlocks happen / are solved / are prevented" specifically — do you want three distinct simulator modes (a deadlock-causing scenario, a detection/recovery demo, a prevention/avoidance demo like Banker's algorithm), or one unified deadlock sandbox?
- What's the **failure/edge case** experience? (e.g. invalid input, a scheduling scenario with a tie, a deadlock scenario with no safe sequence)

## 4. Visualization & UX

- What's the primary visual metaphor per topic? (Gantt chart bars for scheduling, grid/table for page tables, timeline for deadlock detection, blocks for memory allocation?)
- Do you want animations (processes visibly moving/executing) or is a clean static diagram + step controls enough?
- Should results be shown as **numbers only**, **numbers + chart**, or **numbers + chart + plain-English explanation** of what just happened?
- Is there a "compare algorithms side by side" view (e.g. run the same process list through FCFS vs SJF vs RR and compare waiting times)?
- Mobile-friendly, or desktop-only is fine for now?
- Given your local-first / minimal-dependency preference — are you leaning toward a single-page app with no backend needed (pure client-side JS), or do you want a FastAPI backend doing the simulation logic?

## 5. Pedagogical / Content Design

- Do you want **inline explanations** of the algorithm (e.g. a sidebar explaining how SJF works) or do you assume the user already knows the theory and just wants to see it in action?
- Should there be **worked examples** bundled in (classic textbook problems, pre-loaded)?
- Do you want a **quiz/test-yourself mode** per topic (e.g. "predict the Gantt chart before we reveal it")?
- Any plan for citing/aligning content to a specific syllabus (GTU / Navrachana OS course) so it doubles as exam prep?
- Do you want a glossary of terms bundled in, similar in spirit to what you did for the COA notes?

## 6. Technical Architecture

- Frontend stack: confirm React/Vite/Tailwind (matches your usual stack) — any component library, or hand-rolled?
- Does simulation logic live entirely in the frontend, or is there a backend (FastAPI) computing results and returning them?
- How is each topic's simulator structured in code — one shared "simulation engine" abstraction, or fully independent modules per topic?
- Data model: how do you represent a "process," a "page table," a "resource allocation graph" etc. in code — is there a shared schema, or per-topic types?
- State management approach for step-through/replay functionality (undo/redo stacks, snapshot list, etc.)?
- Persistence: does anything need to be saved (user's custom scenarios, quiz scores)? Local storage, or a backend DB?
- Deployment target: static hosting, self-hosted, or something else?

## 7. Scope Boundaries (v1 vs later)

- What's the **minimum** viable version — one topic, fully working, with which exact features?
- What's explicitly **out of scope for v1** (e.g. multi-topic comparison view, quiz mode, mobile layout)?
- Is there a **deadline** driving this (submission date, semester end), or is it open-ended?
- How much time can you realistically put in per week, and does that match the topic list's size?

## 8. Success Criteria

- How will you know v1 "worked"? (You used it to actually study? A friend used it without you explaining anything? It got submitted as a project and graded well?)
- Is there a target number of topics/algorithms for "done enough to call v1"?
- Any external validation planned — professor review, classmate testing, posting publicly?

## 9. Open Questions / Risks

- Which topic do you expect to be **hardest to simulate accurately** (this is worth flagging early)?
- Any concepts where the "right" visualization isn't obvious yet and needs more research/design thought?
- Anything about scope that worries you (too many topics for the timeline, etc.)?

---

_Once you've answered these, the PRD itself becomes mostly a matter of organizing your answers into: Overview → Goals → Users → Feature list (per topic) → Non-goals → Technical approach → Milestones._