const OpenAI = require('openai');
const { Logger } = require('../utils/logger');

class ScriptWriterAgent {
  constructor(db, credentials) {
    this.db = db;
    this.credentials = credentials;
    this.logger = new Logger('ScriptWriter');
    this.templates = this.loadTemplates();
    this.openai = null;
  }

  async initialize() {
    this.logger.info('Initializing Script Writer Agent...');
    
    const apiKey = this.credentials?.openai?.apiKey || process.env.OPENAI_API_KEY;
    if (apiKey) {
      this.openai = new OpenAI({ apiKey });
      this.logger.info('OpenAI connected for script generation');
    } else {
      this.logger.warn('No OpenAI API key - using template-based generation');
    }
    
    return true;
  }

  loadTemplates() {
    return {
      tutorial: {
        structure: ['hook', 'introduction', 'problem', 'solution_steps', 'demonstration', 'recap', 'cta'],
        tone: 'educational',
        pacing: 'moderate'
      },
      explainer: {
        structure: ['hook', 'question', 'background', 'explanation', 'examples', 'implications', 'summary', 'cta'],
        tone: 'informative',
        pacing: 'steady'
      },
      list: {
        structure: ['hook', 'introduction', 'list_items', 'bonus_item', 'summary', 'cta'],
        tone: 'engaging',
        pacing: 'quick'
      },
      review: {
        structure: ['hook', 'introduction', 'overview', 'pros', 'cons', 'comparison', 'verdict', 'cta'],
        tone: 'analytical',
        pacing: 'detailed'
      },
      story: {
        structure: ['hook', 'setup', 'conflict', 'journey', 'climax', 'resolution', 'lesson', 'cta'],
        tone: 'narrative',
        pacing: 'dynamic'
      }
    };
  }

  async generateScript(strategy) {
    try {
      this.logger.info(`Generating script for: ${strategy.topic}`);
      
      const template = this.templates[strategy.contentType.toLowerCase()] || this.templates.explainer;
      
      // Try AI-powered generation first
      const aiScript = await this.generateScriptWithAI(strategy);
      if (aiScript) {
        const sectionCount = (aiScript.sections || []).length;
        const script = {
          title: this._reconcileTitleCount(aiScript.title, sectionCount),
          hook: { type: 'ai-generated', text: aiScript.hook, duration: '0:00-0:05' },
          introduction: {
            greeting: '',
            topicIntro: aiScript.introduction,
            valueProposition: '',
            credibility: '',
            duration: '0:05-0:20'
          },
          mainContent: {
            sections: (aiScript.sections || []).map(s => ({
              type: 'ai-generated',
              title: s.title,
              content: s.content,
              visuals: s.visuals ? [s.visuals] : [],
              duration: s.duration || 60
            })),
            totalDuration: (aiScript.sections || []).reduce((sum, s) => sum + (s.duration || 60), 0)
          },
          conclusion: {
            type: 'conclusion',
            title: 'Wrapping Up',
            recap: [aiScript.conclusion],
            finalThought: '',
            duration: '30 seconds'
          },
          callToAction: {
            type: 'call_to_action',
            subscribe: aiScript.callToAction,
            like: '',
            comment: '',
            nextVideo: '',
            duration: '15 seconds'
          },
          duration: '0:00',
          tone: template.tone,
          pacing: template.pacing,
          keywords: strategy.keywords,
          metadata: {
            strategy: strategy,
            generatedAt: new Date().toISOString(),
            version: '1.0',
            generatedWith: 'ai'
          }
        };
        
        script.duration = this.estimateDuration(script.mainContent);
        script.fullScript = this.formatFullScript(script);
        await this.db.saveScript(script);
        this.logger.info(`AI-generated script: ${script.title}`);
        return script;
      }

      this.logger.info('Falling back to template-based generation');
      
      // Template-based fallback (original logic)
      const hook = await this.generateHook(strategy);
      const introduction = await this.generateIntroduction(strategy);
      const mainContent = await this.generateMainContent(strategy, template);
      const conclusion = await this.generateConclusion(strategy);
      const cta = await this.generateCTA(strategy);

      // Assemble complete script
      const script = {
        title: await this.generateTitle(strategy),
        hook,
        introduction,
        mainContent,
        conclusion,
        callToAction: cta,
        duration: this.estimateDuration(mainContent),
        tone: template.tone,
        pacing: template.pacing,
        keywords: strategy.keywords,
        metadata: {
          strategy: strategy,
          generatedAt: new Date().toISOString(),
          version: '1.0'
        }
      };

      // Format for readability
      script.fullScript = this.formatFullScript(script);
      
      // Save to database
      await this.db.saveScript(script);
      
      this.logger.info(`Script generated: ${script.title}`);
      return script;
    } catch (error) {
      this.logger.error('Failed to generate script:', error);
      throw error;
    }
  }

  async generateWithAI(systemPrompt, userPrompt) {
    if (!this.openai) return null;
    try {
      const response = await this.openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.8,
        max_tokens: 3000
      });
      return response.choices[0].message.content;
    } catch (error) {
      this.logger.error('AI generation failed:', error);
      return null;
    }
  }

  async generateScriptWithAI(strategy) {
    if (!this.openai) return null;
    
    const systemPrompt = `You are a professional YouTube script writer. Write engaging, well-structured video scripts optimized for audience retention. Output valid JSON only, no markdown fences.`;
    
    const userPrompt = `Write a complete YouTube video script for the following:
Topic: ${strategy.topic}
Angle: ${strategy.angle}
Content Type: ${strategy.contentType}
Target Audience: ${strategy.targetAudience}

Return a JSON object with these fields:
{
  "title": "compelling video title",
  "hook": "attention-grabbing opening line (5 seconds)",
  "introduction": "brief intro establishing value (15 seconds)",
  "sections": [
    {"title": "section name", "content": "full narration text for this section", "duration": estimated_seconds, "visuals": "visual direction notes"}
  ],
  "conclusion": "recap and final thought",
  "callToAction": "subscribe/like/comment prompt"
}

Requirements:
- Make the content factual, engaging, and specific to the topic
- Include 3-5 substantive sections with real content
- Each section should have at least 2-3 paragraphs of narration text
- Avoid generic filler phrases
- The hook should immediately grab attention
- IMPORTANT: if the title contains a number (e.g. "Top 5", "7 Moments"),
  that number MUST equal the number of sections. Since you write 3-5
  sections, never promise more than 5 in the title. Prefer matching exactly
  (5 sections -> "Top 5..."). Do not write "Top 10" with only 5 sections.
- Return ONLY the JSON object, no other text`;

    const result = await this.generateWithAI(systemPrompt, userPrompt);
    if (!result) return null;
    
    try {
      const cleaned = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      return JSON.parse(cleaned);
    } catch (error) {
      this.logger.error('Failed to parse AI script response:', error);
      return null;
    }
  }

  // Safety net: if a listicle title promises a number of items that doesn't
  // match the actual section count (e.g. "Top 10" with only 5 sections),
  // rewrite the number to match. Prevents over-promising titles on YouTube.
  _reconcileTitleCount(title, sectionCount) {
    if (!title || !sectionCount) return title;
    // Match a leading/standalone count like "Top 10", "10 ", "7 Best".
    const m = title.match(/\b(\d{1,2})\b/);
    if (!m) return title;
    const promised = parseInt(m[1], 10);
    // Only correct plausible listicle counts (2-20) that overshoot the content.
    if (promised >= 2 && promised <= 20 && promised !== sectionCount) {
      const fixed = title.replace(m[0], String(sectionCount));
      this.logger.info(`Title promised ${promised} but script has ${sectionCount} sections; corrected to "${fixed}"`);
      return fixed;
    }
    return title;
  }

  /**
   * Generate a SHORT-form script for a single football moment (YouTube Shorts).
   * One punchy section, hook-heavy, <=150 words (~50-55s narration). Returns a
   * script object in the same shape the assembly/SEO/upload code expects.
   * `moment` = { title, hint, recent? } from the moments provider.
   */
  async generateShortScript(moment) {
    const subject = moment.title;
    const systemPrompt = `You are a viral YouTube Shorts scriptwriter for a FOOTBALL (soccer) channel. ` +
      `Shorts live or die in the first 1-2 seconds. Write a single, punchy narration for ONE ` +
      `football moment that hooks HARD and immediately. Output valid JSON only, no markdown.`;
    const userPrompt = `Write a YouTube Short narration about this football moment: "${subject}".${moment.hint ? ' Context: ' + moment.hint : ''}

Return JSON:
{
  "title": "punchy Shorts title (<=70 chars, no clickbait lies)",
  "hookText": "3-6 word BIG on-screen hook for the first frame — a curiosity gap or bold claim, e.g. 'The goal that broke records', 'Nobody saw this coming', 'Wait for the finish'. NO period. Punchy, scroll-stopping.",
  "hook": "the SPOKEN opening line (1 sentence) — start mid-tension with a bold claim or question that creates a curiosity gap; NO slow throat-clearing like 'witness the magic' or 'in this video'. Make the viewer NEED to keep watching.",
  "sections": [
    {"title": "short on-screen caption (<=6 words)", "content": "the full narration", "duration": 50, "visuals": "visual direction"}
  ],
  "callToAction": "one short line e.g. 'Follow for more football moments'"
}

Rules:
- TOTAL narration (hook + content) MUST be <= 150 words (~50 seconds spoken).
- The SPOKEN hook must hit in the first 2 seconds — concrete tension, no warm-up.
  BAD: "Witness the magic of Messi." GOOD: "This is the goal that silenced 80,000 fans."
- hookText is a SEPARATE, very short on-screen line (NOT a sentence) for big bold display.
- Be factual and specific about the moment; this is football/soccer only.
- Exactly ONE section.
- Return ONLY the JSON object.`;

    const result = await this.generateWithAI(systemPrompt, userPrompt);
    let ai = null;
    if (result) {
      try { ai = JSON.parse(result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()); }
      catch (e) { this.logger.error('Failed to parse short script:', e); }
    }

    // Fallback if AI unavailable/unparseable.
    if (!ai) {
      ai = {
        title: subject,
        hookText: 'You have to see this',
        hook: `${subject} - one of football's greatest moments.`,
        sections: [{ title: subject.slice(0, 40), content:
          `${subject}. ${moment.hint || ''} A moment football fans will never forget.`,
          duration: 45, visuals: subject }],
        callToAction: 'Follow for more football moments'
      };
    }

    const section = (ai.sections && ai.sections[0]) || {};
    return {
      title: (ai.title || subject).slice(0, 100),
      // Big on-screen first-frame hook (3-6 words). Distinct from the spoken hook.
      hookText: (ai.hookText || '').slice(0, 40),
      hook: { type: 'ai-generated', text: ai.hook || '', duration: '0:00-0:02' },
      introduction: { greeting: '', topicIntro: '', valueProposition: '', credibility: '', duration: '' },
      mainContent: {
        sections: [{
          type: 'ai-generated',
          title: section.title || subject.slice(0, 40),
          content: section.content || ai.hook || subject,
          visuals: section.visuals ? [section.visuals] : [subject],
          duration: Math.min(section.duration || 50, 58)
        }],
        totalDuration: Math.min(section.duration || 50, 58)
      },
      conclusion: { type: 'conclusion', title: '', recap: [], duration: '' },
      callToAction: { type: 'call_to_action', subscribe: ai.callToAction || 'Follow for more football moments', like: '', comment: '' },
      duration: Math.min(section.duration || 50, 58),
      keywords: [],
      format: 'short',
      metadata: { isShort: true, moment: subject, recent: !!moment.recent, createdAt: new Date().toISOString() }
    };
  }

  // Recap script for a real match. format 'long' => multi-section recap;
  // 'short' => single punchy summary. `match` = normalized match object from
  // worldcup-provider (homeTeam, awayTeam, homeScore, awayScore, stage, competition).
  async generateMatchRecapScript(match, { format = 'long' } = {}) {
    const isShort = format === 'short';
    const fixture = `${match.homeTeam} ${match.homeScore}-${match.awayScore} ${match.awayTeam}`;
    // Include the tournament year (derived from the match date, so it stays
    // correct for any edition) so titles read e.g. "FIFA World Cup 2026" rather
    // than an undated "FIFA World Cup".
    const wcYear = match.utcDate ? new Date(match.utcDate).getUTCFullYear() : null;
    let comp = match.competition || 'FIFA World Cup';
    if (wcYear && !comp.includes(String(wcYear))) comp = `${comp} ${wcYear}`;
    const ctx = `${comp}${match.stage ? ' (' + String(match.stage).replace(/_/g, ' ').toLowerCase() + ')' : ''}`;

    const systemPrompt = `You are a football (soccer) match-recap scriptwriter for a YouTube channel. ` +
      `Write an engaging, factual narration recapping a real match result. Output valid JSON only, no markdown. ` +
      `Do NOT invent specific goalscorers, minutes, or events you can't be sure of — focus on the result, ` +
      `the occasion, and the stakes. Keep it confident but not fabricated.`;

    const userPrompt = isShort
      ? `Write a YouTube Short narration recapping this match: ${fixture}. Competition: ${ctx}.
Return JSON:
{ "title": "punchy title <=70 chars incl. the score",
  "hook": "1-sentence hook in the first 2 seconds",
  "sections": [{"title":"<=6 word caption","content":"full narration","duration":50,"visuals":"visual direction"}],
  "callToAction":"one short line" }
Rules: TOTAL narration <= 150 words. Exactly ONE section. Factual about the result. ONLY the JSON.`
      : `Write a YouTube match-recap narration for: ${fixture}. Competition: ${ctx}.
Return JSON:
{ "title": "compelling title <=80 chars incl. teams & score",
  "hook": "strong opening line",
  "sections": [
    {"title":"The Build-Up","content":"...","duration":35,"visuals":"..."},
    {"title":"The Match","content":"...","duration":50,"visuals":"..."},
    {"title":"The Result","content":"...","duration":35,"visuals":"..."}
  ],
  "callToAction":"subscribe line" }
Rules: 3 sections, ~250-350 words total. Factual about the ${fixture} result and what it means in the tournament. ONLY the JSON.`;

    let ai = null;
    const result = await this.generateWithAI(systemPrompt, userPrompt);
    if (result) {
      try { ai = JSON.parse(result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()); }
      catch (e) { this.logger.error('Failed to parse match recap script:', e); }
    }

    // Fallback if AI unavailable/unparseable.
    if (!ai) {
      const base = `${fixture} in the ${ctx}.`;
      ai = isShort
        ? { title: `${fixture}`, hook: `${fixture} - here's how it went.`,
            sections: [{ title: 'Full Time', content: `${base} A result the fans won't forget.`, duration: 50, visuals: 'football stadium' }],
            callToAction: 'Follow for more World Cup recaps' }
        : { title: `${fixture} | World Cup Recap`, hook: `${fixture}. Here's the story.`,
            sections: [
              { title: 'The Build-Up', content: `Two sides met in the ${ctx}.`, duration: 35, visuals: 'stadium atmosphere' },
              { title: 'The Match', content: `${base}`, duration: 50, visuals: 'football action' },
              { title: 'The Result', content: `Final score: ${fixture}.`, duration: 35, visuals: 'celebration' },
            ],
            callToAction: 'Subscribe for daily World Cup recaps' };
    }

    const sections = (ai.sections || []).map((s, i) => ({
      type: 'ai-generated',
      title: s.title || `Part ${i + 1}`,
      content: s.content || '',
      visuals: s.visuals ? [s.visuals] : ['football match'],
      duration: Math.min(s.duration || (isShort ? 50 : 40), isShort ? 58 : 90),
    }));
    const totalDuration = sections.reduce((sum, s) => sum + s.duration, 0);

    return {
      title: (ai.title || fixture).slice(0, 100),
      hook: { type: 'ai-generated', text: ai.hook || '', duration: '0:00-0:02' },
      introduction: { greeting: '', topicIntro: '', valueProposition: '', credibility: '', duration: '' },
      mainContent: { sections, totalDuration },
      conclusion: { type: 'conclusion', title: '', recap: [], duration: '' },
      callToAction: { type: 'call_to_action', subscribe: ai.callToAction || 'Subscribe for more', like: '', comment: '' },
      duration: isShort ? Math.min(totalDuration, 58) : totalDuration,
      keywords: [match.homeTeam, match.awayTeam, 'World Cup', 'football', 'soccer'].filter(Boolean),
      format: isShort ? 'short' : 'long',
      metadata: { matchRecap: true, matchId: match.id, fixture, createdAt: new Date().toISOString() },
    };
  }

  async generateTitle(strategy) {
    const templates = [
      `${strategy.angle}`,
      `${strategy.topic}: The Complete Guide`,
      `Everything You Need to Know About ${strategy.topic}`,
      `${strategy.topic} in ${new Date().getFullYear()}: What's Changed?`,
      `The Truth About ${strategy.topic} (Shocking Results)`,
      `How to Master ${strategy.topic} in 30 Days`,
      `${strategy.topic}: Beginner to Expert Guide`
    ];

    // Select based on content type
    if (strategy.contentType === 'Tutorial') {
      return `How to ${strategy.topic}: Step-by-Step Guide`;
    } else if (strategy.contentType === 'List') {
      return `Top 10 ${strategy.topic} Tips You Need to Know`;
    } else if (strategy.contentType === 'Review') {
      return `${strategy.topic} Review: Is It Worth It?`;
    }

    return templates[Math.floor(Math.random() * templates.length)];
  }

  async generateHook(strategy) {
    const hooks = [
      {
        type: 'question',
        text: `Have you ever wondered ${this.generateQuestionAbout(strategy.topic)}?`
      },
      {
        type: 'statistic',
        text: `Did you know that ${this.generateStatistic(strategy.topic)}?`
      },
      {
        type: 'statement',
        text: `${strategy.topic} is about to change everything, and here's why...`
      },
      {
        type: 'challenge',
        text: `Most people think they understand ${strategy.topic}, but they're completely wrong.`
      },
      {
        type: 'promise',
        text: `In the next few minutes, you'll learn exactly how to master ${strategy.topic}.`
      }
    ];

    const selected = hooks[Math.floor(Math.random() * hooks.length)];
    
    return {
      type: selected.type,
      text: selected.text,
      duration: '0:00-0:05'
    };
  }

  generateQuestionAbout(topic) {
    const questions = [
      `why ${topic} is becoming so important`,
      `how ${topic} actually works`,
      `what makes ${topic} different from everything else`,
      `why experts are talking about ${topic}`,
      `how ${topic} could change your life`
    ];
    
    return questions[Math.floor(Math.random() * questions.length)];
  }

  generateStatistic(topic) {
    const stats = [
      `90% of people don't understand ${topic} correctly`,
      `${topic} has grown by 300% in the last year alone`,
      `experts predict ${topic} will be worth billions by 2030`,
      `only 1 in 10 people are using ${topic} effectively`,
      `${topic} can save you hours every single day`
    ];
    
    return stats[Math.floor(Math.random() * stats.length)];
  }

  async generateIntroduction(strategy) {
    return {
      greeting: "Hey everyone, welcome back to the channel!",
      topicIntro: `Today, we're diving deep into ${strategy.topic}.`,
      valueProposition: `By the end of this video, you'll understand exactly ${this.getValueProposition(strategy)}.`,
      credibility: this.getCredibilityStatement(strategy),
      duration: '0:05-0:20'
    };
  }

  getValueProposition(strategy) {
    const propositions = {
      'Tutorial': `how to implement ${strategy.topic} step by step`,
      'Explainer': `what ${strategy.topic} is and why it matters`,
      'List': `the most important things about ${strategy.topic}`,
      'Review': `whether ${strategy.topic} is right for you`,
      'Story': `the incredible journey of ${strategy.topic}`
    };
    
    return propositions[strategy.contentType] || `everything about ${strategy.topic}`;
  }

  getCredibilityStatement(strategy) {
    const statements = [
      "I've spent months researching this topic",
      "After working with hundreds of people on this",
      "Based on the latest research and data",
      "Drawing from real-world experience",
      "Using proven methods and strategies"
    ];
    
    return statements[Math.floor(Math.random() * statements.length)];
  }

  async generateMainContent(strategy, template) {
    const sections = [];
    
    for (const section of template.structure) {
      if (!['hook', 'introduction', 'cta'].includes(section)) {
        sections.push(await this.generateSection(section, strategy));
      }
    }
    
    return {
      sections,
      totalDuration: this.calculateSectionsDuration(sections)
    };
  }

  async generateSection(sectionType, strategy) {
    const sectionGenerators = {
      problem: () => this.generateProblemSection(strategy),
      solution_steps: () => this.generateSolutionSteps(strategy),
      demonstration: () => this.generateDemonstration(strategy),
      explanation: () => this.generateExplanation(strategy),
      examples: () => this.generateExamples(strategy),
      list_items: () => this.generateListItems(strategy),
      pros: () => this.generatePros(strategy),
      cons: () => this.generateCons(strategy),
      comparison: () => this.generateComparison(strategy),
      implications: () => this.generateImplications(strategy)
    };

    const generator = sectionGenerators[sectionType];
    
    if (generator) {
      return await generator();
    }
    
    return this.generateGenericSection(sectionType, strategy);
  }

  async generateProblemSection(strategy) {
    return {
      type: 'problem',
      title: 'The Challenge',
      content: [
        `Many people struggle with ${strategy.topic}.`,
        `The main issues are:`,
        `1. Lack of clear information`,
        `2. Complexity and confusion`,
        `3. Not knowing where to start`,
        `But don't worry, we're going to solve all of these today.`
      ],
      visuals: ['Problem illustration', 'Statistics graphic'],
      duration: 30
    };
  }

  async generateSolutionSteps(strategy) {
    const steps = [];
    const numSteps = 3 + Math.floor(Math.random() * 3); // 3-5 steps
    
    for (let i = 1; i <= numSteps; i++) {
      steps.push({
        number: i,
        title: `Step ${i}: ${this.generateStepTitle(strategy.topic, i)}`,
        description: this.generateStepDescription(strategy.topic, i),
        tip: this.generateProTip(strategy.topic)
      });
    }
    
    return {
      type: 'solution_steps',
      title: 'The Solution',
      steps,
      duration: steps.length * 45
    };
  }

  generateStepTitle(topic, stepNumber) {
    const titles = [
      'Research and Preparation',
      'Setting Up the Foundation',
      'Implementation and Execution',
      'Testing and Optimization',
      'Scaling and Automation'
    ];
    
    return titles[stepNumber - 1] || `Advanced ${topic} Techniques`;
  }

  generateStepDescription(topic, stepNumber) {
    return `This step involves understanding the key aspects of ${topic} and how to apply them effectively. Pay special attention to the details here, as they make all the difference.`;
  }

  generateProTip(topic) {
    const tips = [
      `Pro tip: Start small and scale gradually`,
      `Remember: Consistency is more important than perfection`,
      `Quick tip: Document everything as you go`,
      `Expert advice: Focus on one aspect at a time`,
      `Insider secret: This works best when combined with regular practice`
    ];
    
    return tips[Math.floor(Math.random() * tips.length)];
  }

  async generateDemonstration(strategy) {
    return {
      type: 'demonstration',
      title: 'Live Demo',
      content: [
        `Now let me show you exactly how this works.`,
        `[Screen recording or visual demonstration]`,
        `As you can see, the process is straightforward once you understand the basics.`,
        `The key is to follow the steps exactly as shown.`
      ],
      visuals: ['Screen recording', 'Step-by-step graphics'],
      duration: 120
    };
  }

  async generateExplanation(strategy) {
    return {
      type: 'explanation',
      title: 'Deep Dive',
      content: [
        `Let's break down ${strategy.topic} into its core components.`,
        `First, we need to understand the fundamental principles.`,
        `The science behind this is fascinating...`,
        `[Detailed explanation with visuals]`,
        `This is why ${strategy.topic} works so effectively.`
      ],
      visuals: ['Diagrams', 'Infographics', 'Charts'],
      duration: 90
    };
  }

  async generateExamples(strategy) {
    return {
      type: 'examples',
      title: 'Real-World Examples',
      content: [
        `Let's look at some real examples of ${strategy.topic} in action.`,
        `Example 1: [Specific case study]`,
        `Example 2: [Another relevant example]`,
        `Example 3: [Third compelling example]`,
        `These examples show the versatility and power of ${strategy.topic}.`
      ],
      visuals: ['Case study graphics', 'Before/after comparisons'],
      duration: 75
    };
  }

  async generateListItems(strategy) {
    const items = [];
    const numItems = 5 + Math.floor(Math.random() * 6); // 5-10 items
    
    for (let i = 1; i <= numItems; i++) {
      items.push({
        number: numItems - i + 1, // Countdown for engagement
        title: this.generateListItemTitle(strategy.topic, i),
        description: this.generateListItemDescription(strategy.topic),
        impact: this.generateImpactStatement()
      });
    }
    
    return {
      type: 'list_items',
      title: `Top ${numItems} Things About ${strategy.topic}`,
      items,
      duration: items.length * 30
    };
  }

  generateListItemTitle(topic, index) {
    const titles = [
      `The Hidden Power of ${topic}`,
      `Why ${topic} Matters More Than You Think`,
      `The Surprising Truth About ${topic}`,
      `How ${topic} Can Transform Your Approach`,
      `The ${topic} Secret Nobody Talks About`,
      `Mastering ${topic} in Record Time`,
      `The Ultimate ${topic} Hack`,
      `${topic}: The Game Changer`,
      `Breaking Down ${topic} Myths`,
      `The Future of ${topic}`
    ];
    
    return titles[index - 1] || `Advanced ${topic} Technique #${index}`;
  }

  generateListItemDescription(topic) {
    return `This aspect of ${topic} is crucial because it fundamentally changes how we approach the subject. Understanding this will give you a significant advantage.`;
  }

  generateImpactStatement() {
    const impacts = [
      'This alone can save you hours',
      'Game-changing for beginners',
      'Essential for long-term success',
      'Often overlooked but critical',
      'The difference between success and failure'
    ];
    
    return impacts[Math.floor(Math.random() * impacts.length)];
  }

  async generatePros(strategy) {
    return {
      type: 'pros',
      title: 'The Benefits',
      points: [
        'Easy to get started',
        'Cost-effective solution',
        'Proven results',
        'Scalable approach',
        'Community support'
      ],
      duration: 45
    };
  }

  async generateCons(strategy) {
    return {
      type: 'cons',
      title: 'Things to Consider',
      points: [
        'Learning curve at the beginning',
        'Requires consistent effort',
        'Results may vary',
        'Some technical knowledge helpful'
      ],
      duration: 30
    };
  }

  async generateComparison(strategy) {
    return {
      type: 'comparison',
      title: 'How It Compares',
      content: `Compared to alternatives, ${strategy.topic} stands out because of its unique approach and proven effectiveness.`,
      comparisonPoints: [
        'More efficient than traditional methods',
        'Better ROI than competitors',
        'Easier to implement',
        'More sustainable long-term'
      ],
      duration: 60
    };
  }

  async generateImplications(strategy) {
    return {
      type: 'implications',
      title: 'What This Means',
      content: [
        `The implications of ${strategy.topic} are far-reaching.`,
        'This will change how we think about the industry.',
        'Early adopters will have a significant advantage.',
        'The potential for growth is enormous.'
      ],
      duration: 45
    };
  }

  generateGenericSection(sectionType, strategy) {
    return {
      type: sectionType,
      title: sectionType.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
      content: `This section covers important aspects of ${strategy.topic} that you need to know.`,
      duration: 60
    };
  }

  async generateConclusion(strategy) {
    return {
      type: 'conclusion',
      title: 'Wrapping Up',
      recap: [
        `So that's everything you need to know about ${strategy.topic}.`,
        'We covered the key points:',
        '- The fundamentals and why they matter',
        '- Practical steps to get started',
        '- Real-world applications and examples',
        '- Tips for long-term success'
      ],
      finalThought: `Remember, ${strategy.topic} is a journey, not a destination. Keep learning and improving!`,
      duration: '30 seconds'
    };
  }

  async generateCTA(strategy) {
    return {
      type: 'call_to_action',
      subscribe: "If you found this helpful, make sure to subscribe and hit the notification bell!",
      like: "Give this video a thumbs up if you learned something new.",
      comment: `Let me know in the comments: What's your experience with ${strategy.topic}?`,
      nextVideo: "Check out this related video for more insights.",
      duration: '15 seconds'
    };
  }

  formatFullScript(script) {
    let fullScript = '';
    
    // Title
    fullScript += `TITLE: ${script.title}\n\n`;
    fullScript += '═'.repeat(50) + '\n\n';
    
    // Hook
    fullScript += `[${script.hook.duration}] HOOK\n`;
    fullScript += `${script.hook.text}\n\n`;
    
    // Introduction
    fullScript += `[${script.introduction.duration}] INTRODUCTION\n`;
    fullScript += `${script.introduction.greeting}\n`;
    fullScript += `${script.introduction.topicIntro}\n`;
    fullScript += `${script.introduction.valueProposition}\n`;
    fullScript += `${script.introduction.credibility}\n\n`;
    
    // Main Content
    fullScript += 'MAIN CONTENT\n';
    fullScript += '─'.repeat(30) + '\n\n';
    
    for (const section of script.mainContent.sections) {
      fullScript += `[${this.formatDuration(section.duration)}] ${section.title.toUpperCase()}\n`;
      
      if (Array.isArray(section.content)) {
        section.content.forEach(line => {
          fullScript += `${line}\n`;
        });
      } else if (section.steps) {
        section.steps.forEach(step => {
          fullScript += `\n${step.title}\n`;
          fullScript += `${step.description}\n`;
          fullScript += `💡 ${step.tip}\n`;
        });
      } else if (section.items) {
        section.items.forEach(item => {
          fullScript += `\n#${item.number}: ${item.title}\n`;
          fullScript += `${item.description}\n`;
          fullScript += `Impact: ${item.impact}\n`;
        });
      } else if (section.points) {
        section.points.forEach(point => {
          fullScript += `• ${point}\n`;
        });
      } else {
        fullScript += `${section.content}\n`;
      }
      
      if (section.visuals) {
        fullScript += `\n[VISUALS: ${section.visuals.join(', ')}]\n`;
      }
      
      fullScript += '\n';
    }
    
    // Conclusion
    fullScript += `[${script.conclusion.duration}] CONCLUSION\n`;
    script.conclusion.recap.forEach(line => {
      fullScript += `${line}\n`;
    });
    fullScript += `\n${script.conclusion.finalThought}\n\n`;
    
    // Call to Action
    fullScript += `[${script.callToAction.duration}] CALL TO ACTION\n`;
    fullScript += `${script.callToAction.subscribe}\n`;
    fullScript += `${script.callToAction.like}\n`;
    fullScript += `${script.callToAction.comment}\n`;
    fullScript += `${script.callToAction.nextVideo}\n\n`;
    
    // Metadata
    fullScript += '═'.repeat(50) + '\n';
    fullScript += `ESTIMATED DURATION: ${script.duration}\n`;
    fullScript += `TONE: ${script.tone}\n`;
    fullScript += `PACING: ${script.pacing}\n`;
    fullScript += `KEYWORDS: ${script.keywords.join(', ')}\n`;
    
    return fullScript;
  }

  estimateDuration(mainContent) {
    const totalSeconds = mainContent.sections.reduce((total, section) => {
      return total + (section.duration || 60);
    }, 0);
    
    // Add hook, intro, conclusion, CTA
    const fullDuration = totalSeconds + 5 + 15 + 30 + 15;
    
    return this.formatDuration(fullDuration);
  }

  formatDuration(seconds) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  }

  calculateSectionsDuration(sections) {
    return sections.reduce((total, section) => total + (section.duration || 60), 0);
  }
}

module.exports = { ScriptWriterAgent };