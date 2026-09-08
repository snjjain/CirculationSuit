'use strict';
/**
 * task_types.js — the catalogue of work a manager can assign.
 *
 * ONE definition, shared. The API validates against it and the browser renders from it
 * (via GET /api/dcr-m/task-types), so a type cannot exist on one side and not the other,
 * and a label cannot drift between the manager's form and the executive's phone.
 *
 * A tour is one of these, not a separate thing. It kept its own screen for as long as it
 * was the only kind of work being handed out; now that a manager assigns collection
 * calls, surveys, complaint visits and feedback rounds through the same queue, the tour
 * is simply the type whose target is a route of agencies.
 *
 * `target` says what the task is pointed at, and the form asks for exactly that:
 *   agent   — a credit agency
 *   hawker  — a cash-sale hawker
 *   either  — agency or hawker, assigner's choice
 *   area    — a locality or market, typed in (no master record exists yet — finding one
 *             is often the point of the task)
 *   none    — no fixed target; the subject carries it
 *
 * `numeric` names the one figure that makes the task measurable, so the executive and the
 * manager work to the same number instead of to a sentence. It maps onto the columns the
 * tour already had — expected_recovery and growth_target — rather than inventing more.
 */

const TASK_TYPES = [
  { key: 'tour', label: 'Assign Tour', label_hi: 'टूर असाइन करें',
    target: 'either', numeric: 'growth_target', multi: true,
    desc: ['Visit specific Agents/Hawkers as per planned route.',
           'Collection, circulation review, feedback and growth discussion.'] },

  { key: 'collection', label: 'Collection Task', label_hi: 'कलेक्शन कार्य',
    target: 'either', numeric: 'expected_recovery', multi: true,
    desc: ['Recover specific outstanding amounts from selected Agents/Hawkers.',
           'Record collection and payment/receipt details.'] },

  { key: 'growth', label: 'Growth / Copy Increase Task', label_hi: 'ग्रोथ / कॉपी वृद्धि',
    target: 'either', numeric: 'growth_target', multi: true,
    desc: ['Meet selected agencies where copy growth is expected.',
           'Discuss and achieve additional copies.'] },

  { key: 'new_development', label: 'New Agency / New Hawker Development', label_hi: 'नई एजेंसी / नया हॉकर',
    target: 'area', numeric: 'growth_target', multi: false,
    desc: ['Identify and develop new Agents/Hawkers in assigned areas.',
           'Capture new business opportunity and expected copies.'] },

  { key: 'new_area', label: 'New Area Development', label_hi: 'नए क्षेत्र का विकास',
    target: 'area', numeric: 'growth_target', multi: false,
    desc: ['Visit a new locality/market where newspaper distribution can be expanded.',
           'Survey potential readers, households and circulation opportunities.'] },

  { key: 'agent_feedback', label: 'Agent Feedback Task', label_hi: 'एजेंट फीडबैक',
    target: 'agent', numeric: null, multi: true,
    desc: ['Visit selected agents and complete the prescribed feedback questionnaire.',
           'Capture issues, satisfaction, competition and suggestions.'] },

  { key: 'outstanding_followup', label: 'Outstanding Follow-up', label_hi: 'बकाया फॉलो-अप',
    target: 'agent', numeric: 'expected_recovery', multi: true,
    desc: ['Follow up with agencies having overdue/high outstanding.',
           'Record payment commitment date and follow-up status.'] },

  { key: 'complaint', label: 'Complaint / Issue Resolution', label_hi: 'शिकायत / समस्या समाधान',
    target: 'either', numeric: null, multi: true,
    desc: ['Visit an Agent/Hawker regarding a specific complaint or operational issue.',
           'Record the issue, action taken and resolution status.'] },

  { key: 'competition_survey', label: 'Competition Survey', label_hi: 'प्रतिस्पर्धा सर्वे',
    target: 'area', numeric: null, multi: false,
    desc: ['Collect information about competing newspapers, copies, pricing, schemes and market activity.',
           'Submit market intelligence.'] },

  { key: 'market_survey', label: 'Market / Area Survey', label_hi: 'मार्केट / क्षेत्र सर्वे',
    target: 'area', numeric: null, multi: false,
    desc: ['Survey a particular locality for population, households, readers and circulation potential.',
           'Generate potential lead/opportunity data.'] },

  { key: 'reader_lead', label: 'Reader Lead / New Subscription', label_hi: 'पाठक लीड / नई सदस्यता',
    target: 'area', numeric: 'growth_target', multi: false,
    desc: ['Visit or contact potential readers generated through survey/lead data.',
           'Record conversion opportunity and expected copies.'] },

  { key: 'payment_commitment', label: 'Payment Commitment Follow-up', label_hi: 'भुगतान वचन फॉलो-अप',
    target: 'agent', numeric: 'expected_recovery', multi: true,
    desc: ['Visit agencies whose committed payment date is due.',
           'Update actual payment status.'] },

  { key: 'digital_adoption', label: 'Digital Collection / App Adoption', label_hi: 'डिजिटल कलेक्शन / ऐप',
    target: 'either', numeric: null, multi: true,
    desc: ['Promote digital payment/collection and ensure Agent App adoption.',
           'Identify reasons where agents are not using the system.'] },

  { key: 'campaign', label: 'Special Campaign / Scheme', label_hi: 'विशेष अभियान / योजना',
    target: 'none', numeric: null, multi: false,
    desc: ['Execute management-assigned circulation campaigns, schemes or promotional activities.',
           'Report activity and outcome.'] },

  { key: 'data_verification', label: 'Data Verification Task', label_hi: 'डेटा सत्यापन',
    target: 'either', numeric: null, multi: true,
    desc: ['Verify Agent/Hawker master information, address, mobile number, location, copies, beat details, etc.',
           'Update discrepancies.'] },

  { key: 'management_special', label: 'Management Special Task', label_hi: 'प्रबंधन विशेष कार्य',
    target: 'none', numeric: null, multi: false,
    desc: ['Any specific assignment from Manager/Incharge.',
           'Example: VIP agency visit, special recovery, event support, urgent market survey, etc.'] },
];

const PRIORITIES = [
  { key: 'urgent', label: 'Urgent',  label_hi: 'अत्यावश्यक', color: '#b91c1c', dot: '🔴' },
  { key: 'high',   label: 'High',    label_hi: 'उच्च',       color: '#c2410c', dot: '🟠' },
  { key: 'normal', label: 'Normal',  label_hi: 'सामान्य',    color: '#1e3a8a', dot: '🔵' },
  { key: 'low',    label: 'Low',     label_hi: 'कम',         color: '#64748b', dot: '⚪' },
];

const TYPE_BY_KEY = new Map(TASK_TYPES.map(t => [t.key, t]));
const isTaskType  = k => TYPE_BY_KEY.has(String(k || ''));
const typeOf      = k => TYPE_BY_KEY.get(String(k || '')) || null;
const labelOf     = k => (TYPE_BY_KEY.get(String(k || '')) || {}).label || String(k || '');
const isPriority  = p => PRIORITIES.some(x => x.key === String(p || ''));

module.exports = { TASK_TYPES, PRIORITIES, isTaskType, typeOf, labelOf, isPriority };
