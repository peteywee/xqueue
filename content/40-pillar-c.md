### Pillar C — Building in public

*36 posts. Applying the frameworks to your own product. Written to the constraint in §7: your product and your thinking only, never a named operator relationship.*

**C1 · VRIO on your own product** *(attach figure 23)*
```
I ran a strategy framework on my own company and it told me
my code is worthless.

VRIO asks four things about a resource: valuable, rare,
costly to imitate, organized to capture.

My codebase: valuable, sort of rare, and trivially imitable.
A competent dev rebuilds it in a few months.

What actually passes: fifteen years of back-of-house
experience attached to someone who can also ship software.
That can't be hired quickly and can't be copied by watching.

The moat was never the product. Worth knowing before you
spend another six months on features.
```

**C2 · Founder hours**
```
The largest cost in my business doesn't appear in any ledger.

It's my own hours. And because I don't invoice myself, the
whole venture looks far cheaper than it is.

Opportunity cost says the real price of an hour is the value
of the next best use of it. For me that's a knowable wage.

Not counting it is how people work on something for three
years without ever finding out whether the economics close.
```

**C3 · Five Forces**
```
I analyzed my competition and found my biggest competitor is
"nothing at all."

Not other software. A laminated binder, a shift lead pointing
at a station, and most often no training program whatsoever.

Nothing is free, already installed, and has no procurement
process. It's the market leader in my category by a wide
margin.

If you can't beat nothing, you don't have a product.
```

**C4 · Pilot design**
```
A pilot that can't tell a real effect from an accident
produces a testimonial, not evidence.

Three rules I'm holding myself to:

Define the measure before it starts, not after you see which
number looks good.

Get a comparison. A group improving over time proves nothing —
new hires get faster anyway.

Say the confound out loud. I'd be running this where I work,
so my presence is a plausible cause of any improvement. Better
I name that than the buyer does.
```

**C5 · Secondary risk**
```
Risk management concept almost nobody applies: your response
to a risk creates new risk.

I'm rebuilding my product's architecture. Correct call —
the debt is real.

It also eats the scarcest thing I have, which is my own hours,
during exactly the window when I might need to move fast
commercially.

That doesn't make the rebuild wrong. It makes the sequencing
a real decision with a real cost instead of a technical detail.
```

**C6 · Contract-first**
```
I stopped writing features and spent a week writing the rules
the features have to obey.

Schemas, boundaries, what each part is allowed to assume about
every other part. No new functionality shipped that week.

The reason: every bug I'd spent real time on traced back to two
parts of the system disagreeing about what a thing was, and
neither had been wrong on its own terms.

Writing the contract first makes that class of bug impossible
rather than findable.

Slowest week I've had. Probably the highest return.
```

**C7 · Technical debt**
```
Technical debt behaves exactly like financial debt, including
the part people ignore.

You borrow time by taking a shortcut. That's real financing and
sometimes it's correct — shipping this month can be worth more
than shipping clean.

The part that gets ignored is the interest. Every feature built
on top of the shortcut costs a little more than it should, and
you pay that on everything afterward, forever, until you settle
it.

I know exactly which shortcut I took eleven months ago. I've been
paying on it since.
```

**C8 · WBS on my own product**
```
I broke my own product into 53 pieces and found the four I'd
been avoiding.

A work breakdown structure decomposes a project until each piece
is small enough to estimate and assign. That's the stated
purpose.

The unstated one is that it makes avoidance visible. The nodes
with no estimate, no owner, and no start date are the work you've
been routing around for months.

Mine were all in the same category, and the category was the one
I'm least confident in.

The chart didn't tell me anything I didn't know. It just stopped
me from not knowing it.
```

**C9 · Pricing**
```
Pricing per user is wrong for restaurant software and it took me
too long to see why.

Turnover is the whole industry. If the price goes up every time
someone new is hired, the product punishes the operator for the
thing they can't control, in the month it hurts most.

Per location is closer. It's predictable, it survives a bad
quarter, and it doesn't create a reason to leave people out of
training.

Pricing isn't a number. It's a behavior you're choosing to
encourage, and the per-seat version encourages under-training.
```

**C10 · Removing my own metrics**
```
I deleted the traction numbers from my own pitch materials
because I couldn't defend how they were produced.

They weren't invented out of nothing. They were the kind of
projection that gets built to fill a slide and then quietly
becomes a claim.

What replaced them is a description of what the system does and
what it's built to do. Capability, not results.

It's a weaker slide. It's also a slide I can be asked about.

An operator who catches one soft number stops believing the
other nine, and they should.
```

**C11 · Authorization**
```
My product is finished enough to pilot and I haven't deployed it
where I work.

Because I haven't got authorization, and building something that
would be useful to an employer doesn't give you the right to
install it in their operation.

This is slower. It's cost me months of the exact evidence I need
most.

It's also the whole difference between a founder with a pilot and
a former employee with a legal problem. The version of me that
skips this step gets one deployment and no career.

Wait for the yes.
```

**C12 · Buyer is not the user**
```
The person who benefits from my product is a line cook. The
person who buys it has never worked my product's screens.

Those are different people with different problems, and building
for one while selling to the other is where most operational
software dies.

The cook wants to stop being handed a station with no
explanation. The operator wants turnover cost down and a training
record that exists when someone asks for it.

Same product, two arguments. If you only build the first one you
never get in the room, and if you only build the second one
nobody uses what you sold.
```

**C13 · Procurement**
```
The hardest part of selling to restaurants isn't convincing
anyone. It's that there's no process to say yes.

Enterprise software has procurement — a path, a budget line, a
person whose job includes evaluating this.

An independent operator has a GM who is on the floor, an owner
who is at another location, and no calendar slot that means
"evaluate a new system."

Which means the product has to be sellable in the fifteen minutes
between lunch and dinner prep, by someone who is tired.

That's not a marketing constraint. It's a product constraint, and
it should change what you build.
```

**C14 · Build vs buy, my version**
```
I build the part that's the reason to choose this product. I buy
everything else, and I had that backwards for a while.

Auth, payments, email delivery, file storage — all of these are
solved, all of these are cheap, and none of them are why anyone
would choose my product.

I spent three weeks once on something I could have rented for
$29 a month. The three weeks weren't the real cost. The real cost
is that I now maintain it forever.

Anything that isn't the reason you win is overhead you volunteered
for.
```

**C15 · The gate**
```
I have one command that decides whether my product is allowed to
be shown to anyone.

It runs the type checks, the test suite, a build, and a
scripted walkthrough of the demo path. If any piece fails, the
answer is no, regardless of how ready it feels.

The point isn't quality. The point is removing my judgment from a
decision I have a strong incentive to get wrong.

Every founder has demoed something they knew was fragile because
the meeting was already scheduled.

A gate you can't argue with is worth more than a standard you
intend to hold.
```

**C16 · Scope**
```
The feature list I started with had 31 items. What shipped had 6.

Not because the other 25 were bad. Because a product that does
six things well is testable, explainable, and finishable, and a
product that does 31 things is a description of the next four
years.

The discipline is asking what has to be true for the thing to be
useful at all, and refusing everything that only makes it better.

Better is the enemy here. Useful is the bar.
```

**C17 · Distribution**
```
I can build faster than I can reach anyone, and that ratio is the
actual constraint on this business.

The instinct when the numbers are quiet is to build more. It's
familiar, it's measurable, it feels like progress, and I'm good
at it.

But another feature doesn't help a product nobody has seen. The
bottleneck is upstream of the code and has been for a while.

Which is most of the reason this account exists. Writing in
public is the cheapest distribution available to someone with no
budget and a real opinion.
```

**C18 · CAC**
```
The customer acquisition cost that works for my product is
roughly zero, and that fact determined my entire strategy.

Run the arithmetic. A modest monthly price against a realistic
retention period gives you a lifetime value. Whatever fraction of
that you can spend to acquire a customer is your budget.

Mine is small enough that paid acquisition is off the table
entirely.

So the channels have to be ones where the cost is my time rather
than my money: writing, replies, direct conversations, and
whatever comes from someone reading six things and deciding I'm
worth an email.

Constraint first, strategy second. Not the other way around.
```

**C19 · Free**
```
I keep going back and forth on a free tier and here is the actual
tension.

Free removes the procurement problem I don't have an answer for.
Somebody can just try it, and in an industry with no evaluation
process that's worth a lot.

Free also attracts the operators least likely to implement
anything, generates support load from people who will never pay,
and teaches the market a price.

The version I keep landing on is time-limited rather than
feature-limited. You get the whole thing, and then you decide.

Still not sure. Writing it down mostly to find out if I believe
it.
```

**C20 · Churn**
```
My market has 70%+ annual employee turnover and I've stopped
treating that as a problem to work around.

Every product decision that assumes a stable user base is wrong
here. Onboarding isn't a first-week event, it's the permanent
condition. Personalization has a short payback. Anything
requiring accumulated familiarity fails.

But turnover is also the reason the product exists. A place that
never lost anyone wouldn't need a training system.

The thing that makes the market hard is the thing that makes it a
market. That took me embarrassingly long.
```

**C21 · Mobile-first**
```
I built this for a phone because I've watched where training
actually happens, and it is not at a desk.

There is no desk. There's a phone in an apron pocket, four
minutes between the prep list and the door, and a screen someone
is reading with one hand.

Every design decision falls out of that. Short units. No typing.
Legible in bad light. Works when it loads slowly.

Most software for this industry was designed by people picturing
an office, and it shows in the first thirty seconds.

Watch where the work happens before you decide what the work
looks like.
```

**C22 · Offline**
```
Half the buildings I've worked in have a dead spot in the back,
and it's usually the walk-in.

So the product has to keep working when the connection doesn't —
progress saved locally, synced when it comes back.

That's real engineering cost for something no buyer will ever ask
about in a demo.

They'll just quietly stop using it after the third time it lost
their place, and they'll never tell me that's why.

The features people request and the features that decide
retention are frequently different lists.
```

**C23 · Content is the product**
```
I thought I was building software. I'm mostly building content,
and the software is how it gets delivered.

An empty training platform is worth nothing. What an operator is
actually buying is the sequenced, correct, industry-specific
material that would take them 200 hours to write.

Which reframes everything. The moat isn't the app — that's the
part that's copyable. The moat is that I can write a station
module correctly because I've worked the station.

I've been optimizing the wrong half.
```

**C24 · Records**
```
The feature I almost cut is the one operators respond to first.

Not the training. The record that the training happened — who
completed what, when, signed off by whom, exportable.

For a cook it's paperwork. For an operator it's the difference
between "we train our people" and being able to prove it, and the
second one has value the first one doesn't.

Compliance features feel unglamorous when you're building. They
turn out to be a lot of why anyone buys.

The person paying has a different problem than the person using.
```

**C25 · Decaying advantage**
```
The thing that makes me credible in this market has a shelf life
and the clock is already running.

Fifteen years of back-of-house experience is real. It's also
frozen the day I stop working the line, and it depreciates from
there. Equipment changes, labor conditions change, the job
changes.

Right now I'm current because I'm still on the schedule. That
won't last.

So the question isn't how to protect the advantage. It's what to
convert it into before it decays — written material, a system,
relationships, a product that encodes it.

Advantages you don't convert are advantages you spend.
```

**C26 · Single point of failure**
```
I ran a risk analysis on my own company and the top risk is me.

Not competition. Not funding. One person holding all the domain
knowledge, all the code, all the relationships, and all the
context, with no documentation good enough for anyone else to
pick it up.

If I'm out for six weeks, the company is out for six weeks.

Every solo founder knows this and almost none of us do anything
about it, because the mitigation — writing everything down — is
the least urgent task available on any given day.

I'm doing it anyway. Slowly, and later than I should have.
```

**C27 · Documents before code**
```
I wrote roughly fifty documents before I wrote the version of
this product I intend to sell.

Terms, policies, data handling, what the system promises, what it
explicitly doesn't, who owns what.

Nobody asked me to. It was, on any given morning, obviously not
the highest-value thing I could do.

But the alternative is writing all of it during a deal, under
time pressure, with the buyer's counsel reading over your
shoulder and every ambiguity resolving against you.

Boring work done early is the cheapest version of that work.
```

**C28 · Security, company of one**
```
Security for a solo founder is not a smaller version of
enterprise security. It's a different problem.

I don't have a team to enforce policy against. What I have is a
handful of decisions that determine almost everything: where
secrets live, what the session model is, what the database will
refuse to do regardless of what the application asks.

I picked one session authority and one migration authority and
made both non-negotiable. Not because I'm disciplined — because I
know I'll be tired at some point and want an exception.

Rules you can't grant yourself an exception to are the only ones
that hold at 1am.
```

**C29 · Saying no**
```
The most useful thing I've said to an interested operator is
"this doesn't do that."

Every instinct pushes the other way. Someone is finally engaged,
they want one more thing, and yes is free in the moment.

It isn't. Yes commits build time you haven't scoped, creates an
expectation you'll be measured against, and pulls the product
toward one operation's specific setup.

The no that keeps the product coherent is worth more than the
deal it might cost — at least while the product is still
finding its shape.

Ask me again in two years.
```

**C30 · The pilot that proves nothing**
```
I designed a pilot, looked at it honestly, and concluded it would
have proven nothing.

Small group, no comparison, measured by asking people whether
they felt more confident, run in a place where I'm present every
day.

Every one of those produces a positive result almost regardless
of whether the product works.

The uncomfortable part is that the flawed version would have
produced a better-sounding case study than the rigorous one will.

Which is a good description of why most vendor case studies read
the way they do.
```

**C31 · Naming**
```
I named the company before I understood the business, and I'd do
it differently now.

A name should either say what the thing does or be empty enough
to fill with meaning later. The bad middle is a name that implies
something adjacent to what you actually sell.

Mine leans hospitality, which is right, and leans upscale, which
isn't quite where the product lives.

Not worth changing at this stage — the switching cost is real and
the name is not the constraint.

But it's a live example of a decision made early on thin
information that you carry for a long time.
```

**C32 · A competitor raised**
```
A better-funded competitor entering your category is not
automatically bad news, and the reflex to panic skips a step.

Funding buys them market education. They will spend money
teaching operators that this category exists and that the problem
is worth solving — which is the expensive part, and I'd be
paying it myself otherwise.

What it doesn't buy is the thing they'd need to beat me on
content, which is time on a line.

Their money is a real advantage. So is the fact that they'll open
the door I couldn't afford to open.
```

**C33 · Time to value**
```
The only metric I'd keep if I had to drop the rest is how long it
takes a new operator to get one useful thing out of the product.

Not signups. Not engagement. Time to the first moment where they
think "oh, that's handy."

Every day of setup between purchase and that moment is a day the
decision can be reversed, and in an industry where the buyer is
interrupted constantly, a long setup is functionally a refusal.

If it takes two weeks to configure, most people never find out
whether it works.
```

**C34 · Selling to the burned**
```
Most operators I talk to have already been sold restaurant
software that didn't work, and that's the actual starting
position.

They're not skeptical of me. They're carrying a specific memory
of a system that took four months to roll out, that nobody used,
and that they're still paying for.

Which means the persuasive move isn't enthusiasm. It's naming
the failure mode first — here's why this usually doesn't work,
here's what I've done about it, here's how you'd know early if
it isn't working.

You can't out-enthusiasm a bad experience. You can acknowledge
it.
```

**C35 · Finishing**
```
I finished a business degree last week and the honest summary is
that it made me more useful in a way I can't fully separate from
the last four years of everything else.

What it definitely did: gave me the vocabulary for things I'd
been doing by instinct, and the frameworks to notice when the
instinct was wrong.

What it didn't do: make me a better operator on its own. The
knowledge is inert until it's attached to a real decision with
real money.

Which is roughly the argument for building something while you
study. The coursework is the cheap half.
```

**C36 · If this doesn't work**
```
Worth writing down while it's still uncertain: what I'd conclude
if this product doesn't find a market.

Not that the idea was wrong. The problem is real and I've lived
it.

More likely conclusions: that I underestimated how hard it is to
reach independent operators without a budget, or that the buying
process I described doesn't exist at the size I targeted, or that
what people needed was a service and I built software.

Naming the likely failure now is the only way to recognize it
early rather than four years in.

Most people define success carefully and leave failure vague. It
should be the other way around.
```
