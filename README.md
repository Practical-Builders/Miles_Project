# PromptCraft — Learn to Speak Fluent AI

PromptCraft is an interactive web app that teaches prompt engineering through structured lessons, knowledge checks, a live AI-powered sandbox, guided missions, and a community prompt library. Users learn by doing — reading concepts, proving comprehension with quizzes, and practicing in the sandbox with real AI feedback.

![Homepage](screenshots/01-hero.png)

---

## Table of Contents

- [Features](#features)
- [Walkthrough](#walkthrough)
  - [Homepage](#homepage)
  - [How It Works](#how-it-works)
  - [Pricing](#pricing)
  - [Sign Up](#sign-up)
  - [Learning Path](#learning-path)
  - [Tier Progression](#tier-progression)
  - [Multi-Page Lessons](#multi-page-lessons)
  - [Knowledge Checks](#knowledge-checks)
  - [Guided Missions](#guided-missions)
  - [Prompt Sandbox](#prompt-sandbox)
  - [Offline Scoring](#offline-scoring)
  - [Prompt Library](#prompt-library)
  - [Leaderboard](#leaderboard)
- [Tech Stack](#tech-stack)
- [Getting Started](#getting-started)

---

## Features

- **5 Skill Tiers** — Foundations → Core Techniques → Advanced Patterns → Domain Tracks → Master Challenges, each unlocked only after completing the previous tier
- **Multi-Page Lessons** — Every lesson is split into 2–3 content pages with a progress indicator, so concepts are absorbed before moving on
- **Knowledge Check Quizzes** — Each lesson ends with a multiple-choice question (harder in higher tiers); wrong answers send you back to re-read before retrying
- **Pro Apply Challenges** — Pro users face an AI-graded sandbox challenge after the quiz; Claude evaluates whether the correct technique was demonstrated, not just a score
- **AI-Powered Sandbox** — Write prompts, get instant quality scoring, improvement tips, a fillable template, and the option to publish high-scoring prompts to the community library
- **Offline Scoring** — Rubric-based structural analysis (no AI runs used) with per-category breakdown bars
- **Guided Missions** — Real-world pass/fail challenges evaluated by Claude
- **Community Prompt Library** — Browse, filter, and copy high-quality prompts; Pro users with scores ≥ 90 can publish their own
- **XP & Streaks** — Earn XP for completing lessons and passing missions, with daily streak tracking
- **Leaderboard** — See how you rank against other learners
- **Dark / Light Mode** — Full theme support across the entire UI
- **User Accounts** — Sign up, log in, and have progress synced server-side

---

## Walkthrough

### Homepage

The landing page introduces PromptCraft with a hero section, key stats, feature highlights, and a clear call to action to get started.

![Homepage Hero](screenshots/01-hero.png)

### How It Works

A three-step breakdown of the learning flow: learn the concept, practice in the sandbox, and complete missions to prove mastery.

![How It Works](screenshots/02-how-it-works.png)

### Pricing

PromptCraft offers a free tier with the first two skill tiers and 10 AI sandbox runs per month. The Pro plan unlocks all five tiers, 200 AI runs per month, AI-graded Pro Apply Challenges, and the ability to publish prompts to the community library.

![Pricing](screenshots/03-pricing.png)

### Sign Up

Create a free account to unlock the sandbox, track XP, and save progress across sessions. Log in from any device and your progress syncs automatically.

![Sign Up Modal](screenshots/04-auth-modal.png)

### Learning Path

Once signed in, the Learn view shows a progress dashboard — total XP, lessons completed, missions passed, and your current streak. Lesson tiers are laid out below with individual cards showing XP reward and page count.

![Learning Path](screenshots/05-learn.png)

### Tier Progression

Tiers are hard-gated: you must complete every lesson in a tier before the next one unlocks. Locked tiers show a clear hint telling you what to finish first.

![Tier Gating](screenshots/06-tier-gating.png)

### Multi-Page Lessons

Each lesson opens in a modal with 2–3 content pages. Progress dots at the top track where you are. The Back button lets you revisit earlier pages, and the Complete button only appears after the quiz — not at the end of reading.

**Page 1 — Concept introduction:**

![Lesson Page 1](screenshots/07-lesson-page1.png)

**Page 2 — Examples and deep dive:**

![Lesson Page 2](screenshots/08-lesson-page2.png)

### Knowledge Checks

After reading through all pages, every lesson ends with a knowledge check quiz. Difficulty scales with tier — Tier 1 tests recall, Tier 5 tests evaluation and judgment. Answer correctly to earn XP; answer wrong and you'll be sent back to re-read the lesson.

![Lesson Quiz](screenshots/09-lesson-quiz.png)

If you get it wrong, the correct answer is highlighted and a "Retry Lesson" button takes you back to page 1.

![Quiz Feedback](screenshots/10-quiz-feedback.png)

### Guided Missions

Expandable mission cards let you try real-world prompt challenges with clear constraints. Each mission is graded by Claude and awards XP on pass.

![Guided Missions](screenshots/11-missions.png)

### Prompt Sandbox

The sandbox is where you put skills into practice. Type any prompt, choose one of the template starters, then pick a mode:

- **Offline Score** — instant structural analysis, no AI run used
- **AI Feedback** — Claude evaluates your prompt and returns a quality score, improvement tips, breakdown by category, and a fillable improved template

![Sandbox](screenshots/12-sandbox.png)

Here's what it looks like with a well-structured prompt ready to analyze:

![Sandbox with Prompt](screenshots/13-sandbox-prompt.png)

### Offline Scoring

The offline scorer checks your prompt for the five core components — role, format, tone, constraint, and context — and returns a score with visual breakdown bars and specific tips for what's missing.

![Offline Scoring Results](screenshots/14-sandbox-offline.png)

### Prompt Library

Browse community-tested prompts across categories: Writing, Code, Research, Marketing, Productivity, and Learning. Each card shows quality score and usage count. Copy any prompt to clipboard or load it straight into the sandbox.

Pro users whose prompts score 90+ in the sandbox can publish directly to the library.

![Prompt Library](screenshots/15-library.png)

### Leaderboard

See the top learners ranked by XP. Track your position as you work through the tiers.

![Leaderboard](screenshots/16-leaderboard.png)

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Single-file HTML / CSS / JS (no framework) |
| Backend | Node.js + Express |
| AI | Anthropic Claude API (`claude-haiku-4-5`) |
| Database | lowdb (JSON file) |
| Auth | JWT + bcrypt |

---

## Getting Started

### Prerequisites

- Node.js 18+
- An [Anthropic API key](https://console.anthropic.com/)

### Installation

1. Clone the repository:

   ```bash
   git clone <repo-url>
   cd Miles_Project
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Create a `.env` file in the project root:

   ```
   ANTHROPIC_API_KEY=your_api_key_here
   JWT_SECRET=your_secret_here
   ```

4. Start the server:

   ```bash
   npm run dev
   ```

5. Open [http://localhost:3000](http://localhost:3000) in your browser.

---

Built as a project for PromptCraft.
