// cover-letters.data.mjs — written cover letters, one per live India role.
//
// Authored 2026-09-10. These replace the template-filled letters that
// tailor-queue.mjs produces, which slot the top three ranked bullets into a
// fixed skeleton and read exactly like that.
//
// EVERY FACTUAL CLAIM HERE ALREADY EXISTS IN cv.md. Nothing is invented: no
// employer, tool, figure, date or qualification appears that is not in that
// file. What differs from a selection-only letter is the PROSE — the framing,
// the connective reasoning, and which two or three proofs are chosen for this
// specific employer.
//
// WHERE A REQUIRED TECHNOLOGY IS NOT HELD, THE LETTER SAYS SO PLAINLY rather
// than steering around it. Salesforce, ServiceNow, Workday, Adobe Journey
// Optimizer and Workfront are all named in these postings and none of them is
// on the CV. Claiming adjacency loosely would be caught in a ten-minute screen
// and costs more credibility than the honest version, which at least reads as
// a person who understood the job.
//
// NEVER MENTIONS visa, sponsorship or work authorisation. the candidate is an Indian
// citizen applying to Indian roles; raising it invents a problem.
//
// Key = the CV filename base, so the renderer can pair them without a lookup.

export const OPENING = 'Dear Hiring Team,';
export const CLOSING = 'I would welcome the chance to discuss the role.';
export const SIGNOFF = 'Kind regards,\nYour Name';

export const LETTERS = {

  'pwc_IN-Senior-Associate-Functional-Business-Analyst-DIgital-Inte': {
    location: 'Gurgaon',
    disclaimed: [],
    role: 'Senior Associate — Functional Business Analyst, Digital Integration, Advisory',
    company: 'PwC',
    paras: [
      'I am writing to apply for the Senior Associate, Functional Business Analyst role in Digital Integration, Advisory in Gurgaon.',
      'For nineteen months at EMPLOYER_ONE I coordinated programme governance across a capital portfolio of roughly £83.6M — the £64.9M PROJECT_ONE, the £10M PROJECT_TWO and the £8.7M PROJECT_THREE — working directly with Directors, Department for Transport officials, Train Operating Companies and Principal Contractors. Advisory work at this level is mostly the discipline of turning messy delivery data into something a decision-maker can act on, and that is what the role was: producing executive reporting that translated detailed cost, schedule and risk information into management insight.',
      'The piece of that work I would point to first is the £100K commercial risk I identified through financial and delivery analysis, early enough for recovery planning before it escalated across the wider programme. Alongside it, I redesigned the SharePoint-based triage and reporting process, which increased team throughput 20% while holding a 97% same-day response rate on executive requests — functional analysis and process redesign, applied to a real workflow with a measurable outcome.',
      'I hold an MSc in Management (Finance) from YOUR_UNIVERSITY, and work hands-on in Power BI, SQL and Advanced Excel. I am based in YOUR_CITY and available immediately.',
    ],
  },

  'pwc_IN-Senior-Associate-Business-Analyst-Tax-Domain-Digital-Inte': {
    location: 'Gurgaon',
    disclaimed: [],
    role: 'Senior Associate — Business Analyst, Tax Domain, Digital Integration, Advisory',
    company: 'PwC',
    paras: [
      'I am writing to apply for the Senior Associate, Business Analyst role in the Tax Domain team within Digital Integration, Advisory in Gurgaon.',
      'I should be straightforward at the outset: my domain experience is in infrastructure and commercial analysis rather than tax. What I bring is the analyst craft the role runs on. At EMPLOYER_ONE I spent nineteen months on a roughly £83.6M capital portfolio, producing executive reporting that translated detailed cost, schedule and risk data into management insight, and maintaining governance through RAID reporting, milestone tracking and action management. Working across three named schemes with Directors, Department for Transport officials and Principal Contractors meant learning a regulated, documentation-heavy environment quickly — which is the transferable part.',
      'My analytical record is quantified rather than asserted. I identified a £100K commercial risk through financial and delivery analysis before it escalated. At EMPLOYER_TWO I standardised CRM datasets using SQL and Excel, cutting manual reporting effort 30% and improving forecast accuracy, and redesigned the lead-to-onboarding process to bring response time from 48 hours down to 4.',
      'My MSc in Management (Finance) from YOUR_UNIVERSITY gives me the financial grounding to pick up tax-domain specifics faster than the CV alone suggests. Based in YOUR_CITY, available immediately.',
    ],
  },

  'sprinklr_Sr-Business-Analyst': {
    location: 'Gurgaon',
    disclaimed: [],
    role: 'Senior Business Analyst',
    company: 'Sprinklr',
    paras: [
      'I am applying for the Senior Business Analyst role in Gurgaon.',
      'The work on my CV closest to this is EMPLOYER_TWO, where I analysed end-to-end commercial pipelines to find conversion bottlenecks and increased qualified lead volume 30%. I built the Power BI and Excel dashboards senior leadership used for commercial planning and investment decisions, ran hypothesis-led A/B testing that produced a 20% uplift in conversion, and standardised CRM datasets in SQL and Excel — cutting manual reporting effort 30% while improving forecast accuracy. That is the full loop: instrument the funnel, find where it leaks, test a change, measure it.',
      'The nineteen months that followed at EMPLOYER_ONE added scale and stakeholder weight. I coordinated governance across a roughly £83.6M capital portfolio and identified a £100K commercial risk through financial and delivery analysis, early enough for recovery planning. I also redesigned a SharePoint-based triage and reporting process, increasing team throughput 20% at a 97% same-day response rate.',
      'I work hands-on in Power BI, SQL and Advanced Excel, hold an MSc in Management (Finance) from YOUR_UNIVERSITY, and am based in YOUR_CITY, available immediately.',
    ],
  },

  'elevancehealth_Reporting-SQL-Sr-Business-Analyst-GR-40207-74077-1-JR201921': {
    location: 'Gurugram',
    disclaimed: [],
    role: 'Senior Business Analyst — Reporting, SQL',
    company: 'Elevance Health',
    paras: [
      'I am applying for the Senior Business Analyst role covering reporting and SQL, based in Gurugram.',
      'Reporting is the through-line of my last three years. At EMPLOYER_ONE I produced executive reporting and decision-support outputs for nineteen months, translating detailed cost, schedule and risk data across a roughly £83.6M capital portfolio into insight Directors and Department for Transport officials could act on. Reporting into that audience sets a particular bar: the number has to be right, and the reason behind it has to be one sentence long.',
      'On the technical side, at EMPLOYER_TWO I built the Power BI and Excel dashboards senior leadership used for commercial planning and investment decisions, and standardised CRM datasets using SQL and Excel — cutting manual reporting effort 30% and improving forecast accuracy. The 30% came from removing manual reconciliation, which is usually where reporting time actually goes.',
      'I also redesigned EMPLOYER_ONE’s SharePoint-based triage and reporting process, increasing team throughput 20% while maintaining a 97% same-day response rate. I hold an MSc in Management (Finance) from YOUR_UNIVERSITY and am completing the Microsoft Power BI Data Analyst certificate. Based in YOUR_CITY, available immediately.',
    ],
  },

  'capco_Business-Analyst-Liquidity': {
    location: 'Bengaluru; Gurugram',
    disclaimed: ['Indraprastha'],
    role: 'Business Analyst — Liquidity',
    company: 'Capco',
    paras: [
      'I am applying for the Business Analyst role in the Liquidity team.',
      'My finance grounding is academic and analytical rather than a liquidity-desk background, and I would rather say that plainly. I hold an MSc in Management (Finance) from YOUR_UNIVERSITY, where my modules covered Corporate Finance, Business Economics, Strategy, FinTech and Management Accounting, and my dissertation examined market efficiency in Indian equities after the 1991 reforms.',
      'What I bring alongside it is nineteen months of regulated, high-scrutiny analysis at EMPLOYER_ONE. I coordinated governance across a roughly £83.6M capital portfolio, produced executive reporting translating cost, schedule and risk data into management insight, and identified a £100K commercial risk through financial and delivery analysis in time for recovery planning. I maintained governance through RAID reporting, milestone tracking and action management — the control-and-evidence discipline that regulatory workstreams run on.',
      'Technically I work in SQL, Power BI and Advanced Excel; at EMPLOYER_TWO I standardised CRM datasets in SQL, cutting manual reporting effort 30% and improving forecast accuracy. Based in YOUR_CITY, available immediately.',
    ],
  },

  'mastercard_Senior-Analyst-Finance-Business-Partner': {
    location: 'Gurgaon',
    disclaimed: [],
    role: 'Senior Analyst — Finance Business Partner',
    company: 'Mastercard',
    paras: [
      'I am applying for the Senior Analyst, Finance Business Partner role in Gurgaon.',
      'Business partnering is analysis with an audience, and for nineteen months at EMPLOYER_ONE that audience was Directors, Department for Transport officials, Train Operating Companies and Principal Contractors. I coordinated governance across a roughly £83.6M capital portfolio and produced the executive reporting that turned detailed cost, schedule and risk data into decisions — including identifying a £100K commercial risk through financial and delivery analysis, early enough for recovery planning before it reached the wider programme.',
      'I also analysed recurring supplier delivery issues and surfaced the commercial pressure points that warranted management intervention, which is the partnering half of the job rather than the reporting half: noticing the pattern and taking it to someone who can act.',
      'At EMPLOYER_TWO I built Power BI and Excel dashboards used by senior leadership for commercial planning and investment decisions, and standardised CRM datasets in SQL, cutting manual reporting effort 30% while improving forecast accuracy. I hold an MSc in Management (Finance) from YOUR_UNIVERSITY. Based in YOUR_CITY, available immediately.',
    ],
  },

  'mastercard_Senior-Analyst-Business-Development-Support': {
    location: 'Gurgaon',
    disclaimed: [],
    role: 'Senior Analyst — Business Development Support',
    company: 'Mastercard',
    paras: [
      'I am applying for the Senior Analyst, Business Development Support role in Gurgaon.',
      'Commercial pipeline analysis is where I started. At EMPLOYER_TWO I analysed end-to-end pipelines to identify conversion bottlenecks and increased qualified lead volume 30%, ran hypothesis-led A/B testing that lifted conversion 20%, and redesigned the lead-to-onboarding process to cut response time from 48 hours to 4. I built the Power BI and Excel dashboards leadership used for commercial planning and investment decisions, and standardised the underlying CRM data in SQL — cutting manual reporting effort 30% and improving forecast accuracy.',
      'Before that, as a business development intern at the same company, I generated 60+ qualified leads weekly and secured 27 paid sign-ups, exceeding targets 20%, and redesigned the qualification and objection-handling frameworks that lifted conversion from 10% to 25%. I understand what business development teams actually need from an analyst, because I have done the front-line half of it.',
      'The nineteen months at EMPLOYER_ONE that followed added executive-level reporting across a roughly £83.6M capital portfolio and an MSc in Management (Finance) from YOUR_UNIVERSITY sits behind both. Based in YOUR_CITY, available immediately.',
    ],
  },

  'WSP_Senior-Consultant-Business-Analyst': {
    location: 'Noida',
    disclaimed: [],
    role: 'Senior Consultant — Business Analyst',
    company: 'WSP',
    paras: [
      'I am applying for the Senior Consultant, Business Analyst role in Noida.',
      'This is the role on my list that maps most directly onto what I have actually done. For nineteen months I was Team Organiser (PMO) in Major Projects & Programmes at EMPLOYER_ONE, coordinating governance across three named capital schemes totalling roughly £83.6M: the £64.9M PROJECT_ONE, the £10M PROJECT_TWO and the £8.7M PROJECT_THREE. I worked directly with Directors, Department for Transport officials, Train Operating Companies and Principal Contractors.',
      'The day-to-day was infrastructure consultancy work in all but title. I maintained governance through RAID reporting, milestone tracking, action management and CDM assurance support; escalated critical-path design delays and programme dependencies; analysed recurring supplier delivery issues to surface commercial pressure points; and identified a £100K commercial risk through financial and delivery analysis in time for recovery planning.',
      'I also redesigned the SharePoint-based triage and reporting process, increasing team throughput 20% at a 97% same-day response rate. I hold an MSc in Management (Finance) from YOUR_UNIVERSITY, work in Power BI, SQL, Advanced Excel, Microsoft Project, AssetWise and ProjectWise, and am based in YOUR_CITY, available immediately.',
    ],
  },

  'mmc_Senior-Consultant-Compensation-Consulting': {
    location: 'Gurugram',
    disclaimed: [],
    role: 'Senior Consultant — Compensation Consulting',
    company: 'Marsh McLennan',
    paras: [
      'I am applying for the Senior Consultant role in Compensation Consulting, Gurugram.',
      'Compensation consulting is not a domain I have worked in, and I would rather lead with that than imply otherwise. What I offer is the analytical and client-facing core of consulting work, evidenced rather than claimed.',
      'At EMPLOYER_ONE I spent nineteen months coordinating governance across a roughly £83.6M capital portfolio, producing executive reporting that translated detailed cost, schedule and risk data into management insight for Directors and Department for Transport officials. I identified a £100K commercial risk through financial and delivery analysis, early enough for recovery planning. Structured problem-solving in front of a demanding audience is the part of that experience I would bring here.',
      'My MSc in Management (Finance) from YOUR_UNIVERSITY covered Corporate Finance and Management Accounting, and at EMPLOYER_TWO I worked with quantitative datasets directly — building Power BI dashboards for leadership decisions and standardising CRM data in SQL, cutting manual reporting effort 30%. Benchmarking and survey analysis are data problems before they are compensation problems, and data problems I can do from day one. Based in YOUR_CITY, available immediately.',
    ],
  },

  'BSR-Co_Associate-Consultant-Cloud-transformation': {
    location: 'Gurgaon',
    disclaimed: [],
    role: 'Associate Consultant — Cloud Transformation',
    company: 'BSR & Co',
    paras: [
      'I am applying for the Associate Consultant role in Cloud Transformation, Gurgaon.',
      'To be direct: I do not have cloud platform experience, and I am applying because the transformation half of the role is work I have done. Most transformation programmes fail on governance, stakeholder alignment and process design rather than on technology, and that is the half I can evidence.',
      'For nineteen months at EMPLOYER_ONE I coordinated programme governance across a roughly £83.6M capital portfolio, working with Directors, Department for Transport officials and Principal Contractors. I maintained RAID reporting, milestone tracking and action management, escalated critical-path delays and dependencies, and identified a £100K commercial risk through financial and delivery analysis before it escalated.',
      'The closest single piece of work is the SharePoint-based triage and reporting redesign I led: a real workflow migration that increased team throughput 20% while holding a 97% same-day response rate. It was small in scale but complete in shape — current state, bottleneck analysis, redesign, adoption, measured outcome.',
      'I hold an MSc in Management (Finance) from YOUR_UNIVERSITY and am completing the Google Project Management certificate. Based in YOUR_CITY, available immediately.',
    ],
  },

  'BSR-Co_Patch-Management-Consultant-MAST': {
    location: 'Gurgaon',
    disclaimed: [],
    role: 'Patch Management Consultant, MAST',
    company: 'BSR & Co',
    paras: [
      'I am applying for the Patch Management Consultant role within MAST.',
      'I should be honest that patch management is outside my technical background. I am applying because the underlying work — tracking a large population of items to a schedule, chasing exceptions, evidencing compliance and reporting status upward — is precisely what I did for nineteen months at EMPLOYER_ONE.',
      'There I maintained governance across a roughly £83.6M capital portfolio through RAID reporting, milestone tracking, action management and CDM assurance support, and escalated critical-path delays and dependencies before they became programme problems. I produced the executive reporting that translated detailed cost, schedule and risk data into management insight for Directors and Department for Transport officials, and identified a £100K commercial risk through financial and delivery analysis.',
      'I also redesigned the SharePoint-based triage and reporting process, increasing team throughput 20% at a 97% same-day response rate — the same instinct a compliance-tracking function needs.',
      'If the technical depth required is greater than the coordination and assurance discipline, I would rather you know that from this letter than discover it in a screen. Based in YOUR_CITY, available immediately.',
    ],
  },

  'crowe_ServiceNow-Implementation-Senior-Consultant': {
    location: 'Noida',
    disclaimed: ['ServiceNow'],
    role: 'ServiceNow Implementation Senior Consultant',
    company: 'Crowe',
    paras: [
      'I am applying for the ServiceNow Implementation Senior Consultant role in Noida.',
      'I have not worked on ServiceNow, and I would rather say so in the first paragraph than have it surface in a screening call. I am applying because implementation consulting is mostly requirements, process design, stakeholder management and disciplined delivery — and those I can evidence.',
      'For nineteen months at EMPLOYER_ONE I coordinated programme governance across a roughly £83.6M capital portfolio, working directly with Directors, Department for Transport officials, Train Operating Companies and Principal Contractors. I maintained governance through RAID reporting, milestone tracking and action management, and identified a £100K commercial risk through financial and delivery analysis in time for recovery planning.',
      'The most relevant single project is the SharePoint-based triage and reporting redesign I ran: mapping the existing workflow, finding the bottleneck, rebuilding the process and getting a team to adopt it — throughput up 20%, with a 97% same-day response rate maintained throughout. That is a platform implementation in miniature.',
      'I hold an MSc in Management (Finance) from YOUR_UNIVERSITY and am completing the Google Project Management certificate. Based in YOUR_CITY, available immediately.',
    ],
  },

  'erm_Senior-Salesforce-Business-Analyst': {
    location: 'New Delhi',
    disclaimed: ['Salesforce'],
    role: 'Senior Salesforce Business Analyst',
    company: 'ERM',
    paras: [
      'I am applying for the Senior Salesforce Business Analyst role in New Delhi.',
      'I have worked with CRM data rather than with Salesforce specifically, and it is worth being clear about the distinction. At EMPLOYER_TWO I standardised CRM datasets using SQL and Excel, cutting manual reporting effort 30% and improving forecast accuracy — which meant understanding how the objects related, where the data went wrong, and what the sales team actually needed out of it. I also analysed end-to-end commercial pipelines to identify conversion bottlenecks, increasing qualified lead volume 30%, and redesigned the lead-to-onboarding process to bring response time from 48 hours to 4.',
      'That is CRM business analysis in substance: pipeline structure, data quality, process redesign and reporting. The platform is the part I would need to learn.',
      'Since then, nineteen months at EMPLOYER_ONE added governance and executive reporting across a roughly £83.6M capital portfolio, and a £100K commercial risk identified through financial and delivery analysis. ERM’s environmental and sustainability focus also sits close to the infrastructure and capital-projects world I came from.',
      'MSc Management (Finance), YOUR_UNIVERSITY. Based in YOUR_CITY, available immediately.',
    ],
  },

  'stryker_IT-Lead-Business-Analyst-Global-Transportation-and-Trade-Com': {
    location: 'Gurugram',
    disclaimed: [],
    role: 'IT Lead Business Analyst — Global Transportation and Trade Compliance',
    company: 'Stryker',
    paras: [
      'I am applying for the IT Lead Business Analyst role covering Global Transportation and Trade Compliance, based in Gurugram.',
      'Transportation and compliance is closer to my background than the title might suggest. For nineteen months I was Team Organiser (PMO) in Major Projects & Programmes at EMPLOYER_ONE, working across a roughly £83.6M rail capital portfolio with Department for Transport officials, Train Operating Companies and Principal Contractors — a transport environment where compliance evidence is not optional. I maintained governance through RAID reporting, milestone tracking, action management and CDM assurance support.',
      'On the analysis side, I analysed recurring supplier delivery issues and identified the commercial pressure points that needed management intervention, and identified a £100K commercial risk through financial and delivery analysis before it escalated. I produced the executive reporting that turned detailed cost, schedule and risk data into decisions.',
      'Technically I work in SQL, Power BI and Advanced Excel; at EMPLOYER_TWO I standardised CRM datasets in SQL, cutting manual reporting effort 30% and improving forecast accuracy. I hold an MSc in Management (Finance) from YOUR_UNIVERSITY. Based in YOUR_CITY, available immediately.',
    ],
  },

  'simcorp_Senior-Service-Delivery-Consultant': {
    location: 'Noida',
    disclaimed: [],
    role: 'Senior Service Delivery Consultant',
    company: 'SimCorp',
    paras: [
      'I am applying for the Senior Service Delivery Consultant role in Noida.',
      'Service delivery is governance, escalation and stakeholder confidence, and that describes my nineteen months at EMPLOYER_ONE closely. As Team Organiser (PMO) in Major Projects & Programmes I coordinated governance across a roughly £83.6M capital portfolio, maintained RAID reporting, milestone tracking and action management, and escalated critical-path design delays and programme dependencies to support delivery planning and risk mitigation.',
      'The stakeholder side was Directors, Department for Transport officials, Train Operating Companies and Principal Contractors — parties whose interests did not always align, which is the useful part of the experience. I analysed recurring supplier delivery issues and surfaced the commercial pressure points that warranted intervention, and identified a £100K commercial risk through financial and delivery analysis.',
      'On responsiveness specifically: I redesigned the SharePoint-based triage and reporting process, increasing team throughput 20% while maintaining a 97% same-day response rate on executive requests. SimCorp’s investment-management domain also connects to my MSc in Management (Finance) from YOUR_UNIVERSITY, where I studied Corporate Finance and FinTech. Based in YOUR_CITY, available immediately.',
    ],
  },

  'inizio_Workday-Business-Analyst': {
    location: 'Gurugram',
    disclaimed: ['Workday'],
    role: 'Workday Business Analyst',
    company: 'Inizio',
    paras: [
      'I am applying for the Workday Business Analyst role in Gurugram.',
      'I have not configured Workday, and that is worth stating up front. I am applying because the business analysis underneath enterprise-system work is what I have done for the last three years.',
      'At EMPLOYER_TWO I standardised CRM datasets using SQL and Excel, cutting manual reporting effort 30% and improving forecast accuracy, and redesigned the lead-to-onboarding process to reduce response time from 48 hours to 4 — requirements, data structure, process redesign, measured result. At EMPLOYER_ONE I spent nineteen months coordinating governance across a roughly £83.6M capital portfolio, producing executive reporting for Directors and Department for Transport officials, and identified a £100K commercial risk through financial and delivery analysis.',
      'The closest analogue to a system implementation is the SharePoint-based triage and reporting redesign I led, which increased team throughput 20% while holding a 97% same-day response rate — including the adoption half, which is usually the harder one.',
      'MSc Management (Finance), YOUR_UNIVERSITY; hands-on Power BI, SQL and Advanced Excel. Based in YOUR_CITY, available immediately.',
    ],
  },

  'travelhrportal_Business-Analyst': {
    location: 'Gurgaon',
    disclaimed: [],
    role: 'Business Analyst',
    company: 'Travel HR Portal',
    paras: [
      'I am applying for the Business Analyst role in Gurgaon.',
      'My analyst work spans two settings that between them cover most of what a generalist BA role needs. At EMPLOYER_TWO I analysed end-to-end commercial pipelines to identify conversion bottlenecks and increased qualified lead volume 30%, built the Power BI and Excel dashboards senior leadership used for planning and investment decisions, ran hypothesis-led A/B testing that lifted conversion 20%, and standardised CRM datasets in SQL — cutting manual reporting effort 30%.',
      'At EMPLOYER_ONE I spent nineteen months on a roughly £83.6M capital portfolio, producing executive reporting that translated cost, schedule and risk data into management insight, maintaining governance through RAID reporting and milestone tracking, and identifying a £100K commercial risk through financial and delivery analysis before it escalated.',
      'Between them: quantitative analysis, dashboarding, process redesign, and reporting to a senior audience. I also redesigned a triage and reporting workflow that increased team throughput 20% at a 97% same-day response rate.',
      'MSc Management (Finance), YOUR_UNIVERSITY. Based in YOUR_CITY, available immediately.',
    ],
  },

  'Happiest-Resume_Senior-Business-Consultant': {
    location: 'Bangalore',
    disclaimed: [],
    role: 'Senior Business Consultant',
    company: 'Happiest Resume',
    paras: [
      'I am applying for the Senior Business Consultant role.',
      'My consulting evidence is a nineteen-month engagement in all but name. As Team Organiser (PMO) in Major Projects & Programmes at EMPLOYER_ONE I coordinated governance across three named capital schemes totalling roughly £83.6M, working directly with Directors, Department for Transport officials, Train Operating Companies and Principal Contractors, and produced the executive reporting that translated detailed cost, schedule and risk data into management insight.',
      'The single result I would put forward is the £100K commercial risk I identified through financial and delivery analysis, surfaced early enough for recovery planning before it escalated across the programme. Alongside it, I redesigned the SharePoint-based triage and reporting process, increasing team throughput 20% while maintaining a 97% same-day response rate.',
      'Earlier, at EMPLOYER_TWO, I analysed commercial pipelines to find conversion bottlenecks and increased qualified lead volume 30%, and ran hypothesis-led A/B testing achieving a 20% uplift in conversion.',
      'I hold an MSc in Management (Finance) from YOUR_UNIVERSITY and work hands-on in Power BI, SQL and Advanced Excel. Based in YOUR_CITY, available immediately.',
    ],
  },

  'vmlenterprisesolutions_AJO-Senior-Consultant': {
    location: 'Noida',
    disclaimed: ['Adobe Journey Optimizer'],
    role: 'AJO Senior Consultant',
    company: 'VML Enterprise Solutions',
    paras: [
      'I am applying for the AJO Senior Consultant role in Noida.',
      'I have not worked in Adobe Journey Optimizer, so this is an application on transferable ground rather than platform experience, and I would rather be clear about that immediately.',
      'The relevant work is EMPLOYER_TWO, where I analysed end-to-end commercial pipelines to identify conversion bottlenecks and increased qualified lead volume 30%, ran hypothesis-led A/B testing that produced a 20% uplift in conversion, and redesigned the lead-to-onboarding process to cut response time from 48 hours to 4. Journey optimisation is that work with a platform attached: map the path, find where people drop out, test a change, measure it. I also standardised the CRM data underneath it using SQL and Excel, cutting manual reporting effort 30% and improving forecast accuracy.',
      'Since then, nineteen months at EMPLOYER_ONE added governance and executive reporting across a roughly £83.6M capital portfolio, and a £100K commercial risk identified through financial and delivery analysis.',
      'MSc Management (Finance), YOUR_UNIVERSITY. Based in YOUR_CITY, available immediately.',
    ],
  },

  'vmlenterprisesolutions_AJO-Senior-Consultant-Database': {
    location: 'Noida',
    disclaimed: ['Adobe Journey Optimizer'],
    role: 'AJO Senior Consultant (Database)',
    company: 'VML Enterprise Solutions',
    paras: [
      'I am applying for the AJO Senior Consultant (Database) role in Noida.',
      'I have not used Adobe Journey Optimizer, and I am applying on the data side of the role rather than the platform side.',
      'At EMPLOYER_TWO I standardised CRM datasets using SQL and Excel — cutting manual reporting effort 30% and improving forecast accuracy — which is the unglamorous half of any customer-data platform: reconciling records, fixing what the source systems get wrong, and making the numbers trustworthy enough to act on. I built the Power BI and Excel dashboards leadership used for commercial planning and investment decisions, analysed end-to-end pipelines to find conversion bottlenecks (qualified lead volume up 30%), and ran A/B testing that lifted conversion 20%.',
      'At EMPLOYER_ONE I then spent nineteen months producing executive reporting across a roughly £83.6M capital portfolio and identified a £100K commercial risk through financial and delivery analysis.',
      'I work hands-on in SQL, Power BI and Advanced Excel, hold an MSc in Management (Finance) from YOUR_UNIVERSITY, and am completing the Microsoft Power BI Data Analyst certificate. Based in YOUR_CITY, available immediately.',
    ],
  },

  'vmlenterprisesolutions_Ultimate-Success-Target-Senior-Consultant': {
    location: 'Noida',
    disclaimed: ['Adobe Target', 'Ultimate Success'],
    role: 'Ultimate Success — Target Senior Consultant',
    company: 'VML Enterprise Solutions',
    paras: [
      'I am applying for the Target Senior Consultant role within Ultimate Success, Noida.',
      'I have not worked in Adobe Target, so I am applying on the experimentation discipline rather than the tool.',
      'At EMPLOYER_TWO I ran hypothesis-led A/B testing that achieved a 20% uplift in conversion — hypothesis first, then the test, then the measurement, rather than changing things and hoping. Around it I analysed end-to-end commercial pipelines to identify conversion bottlenecks, increasing qualified lead volume 30%, and redesigned the lead-to-onboarding process to reduce response time from 48 hours to 4. I built the Power BI and Excel dashboards senior leadership used to act on those results, and standardised the CRM data underneath in SQL, cutting manual reporting effort 30%.',
      'Nineteen months at EMPLOYER_ONE followed, coordinating governance across a roughly £83.6M capital portfolio and identifying a £100K commercial risk through financial and delivery analysis.',
      'MSc Management (Finance), YOUR_UNIVERSITY. Based in YOUR_CITY, available immediately.',
    ],
  },

  'vmlenterprisesolutions_Ultimate-Success-Workfront-Senior-Consultant': {
    location: 'Noida',
    disclaimed: ['Adobe Workfront', 'Ultimate Success'],
    role: 'Ultimate Success — Workfront Senior Consultant',
    company: 'VML Enterprise Solutions',
    paras: [
      'I am applying for the Workfront Senior Consultant role within Ultimate Success, Noida.',
      'I have not used Adobe Workfront. I am applying because work management — intake, prioritisation, throughput and visibility — is what I spent nineteen months doing at EMPLOYER_ONE, and because I have rebuilt exactly that kind of system once already.',
      'As Team Organiser (PMO) in Major Projects & Programmes I coordinated governance across a roughly £83.6M capital portfolio, maintaining RAID reporting, milestone tracking and action management, and escalating critical-path delays and dependencies. The directly relevant project is the SharePoint-based triage and reporting redesign I led: I mapped how executive requests were arriving, found where they were stalling, rebuilt the process, and took team throughput up 20% while holding a 97% same-day response rate.',
      'That is a work-management implementation, including the adoption half. I also identified a £100K commercial risk through financial and delivery analysis before it escalated.',
      'MSc Management (Finance), YOUR_UNIVERSITY; completing the Google Project Management certificate. Based in YOUR_CITY, available immediately.',
    ],
  },
};
