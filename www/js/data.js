/* ═══════════ Patrika Vitran Suite — seed data (from reference prototypes) ═══════════ */
"use strict";
const TODAY = new Date().toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const fmtN = n => n.toLocaleString("en-IN");
const fmtC = n => "₹" + n.toLocaleString("en-IN");
const lakh = n => "₹" + (n / 100000).toFixed(1) + " L";

/* ---- users & permissions — 10-level hierarchy (from Hierarchy levels.docx) ---- */
const USERS = [
  // L1 — Admin (Management / Board View)
  { id:1,  name:"Sanjay Jain",   mobile:"9714022891", password:"patrika@123", role:"admin",             hierarchyLevel:1,  roleLabel:"Admin — Board View",                 scopeLabel:"PAN India",               avatar:"SJ", dashboard:true,  modules:["agent","hawker","dcr","survey","taxi"] },
  // L2 — Vice President
  { id:7,  name:"Vikram Singh",  mobile:"9811111111", password:"vp@123",      role:"vp",                hierarchyLevel:2,  roleLabel:"Vice President",                     scopeLabel:"Rajasthan Region",            avatar:"VS", dashboard:true,  modules:["agent","dcr","survey"] },
  // L3 — Zonal Head
  { id:8,  name:"Ramesh Gupta",  mobile:"9822222222", password:"zonal@123",   role:"zonal_head",        hierarchyLevel:3,  roleLabel:"Zonal Head",                         scopeLabel:"Jaipur Zone — 4 branches",    zone_id:1, branch_id:null, avatar:"RG", dashboard:true,  modules:["agent","dcr"] },
  // L4 — Branch Circulation Incharge
  { id:2,  name:"Raj Sharma",    mobile:"9876543210", password:"branch@123",  role:"branch_incharge",   hierarchyLevel:4,  roleLabel:"Branch Circulation Incharge",        scopeLabel:"Jaipur — Malviya Nagar",      zone_id:1, branch_id:1, avatar:"RS", dashboard:true,  modules:["agent","dcr","survey"] },
  // L5 — District Incharge (Daak)
  { id:9,  name:"Mukesh Verma",  mobile:"9833333333", password:"dist@123",    role:"district_incharge", hierarchyLevel:5,  roleLabel:"District Incharge (Daak)",           scopeLabel:"Jaipur Rural / Daak",         zone_id:1, branch_id:1, avatar:"MV", dashboard:true,  modules:["agent","dcr","survey"] },
  // L6 — City Incharge
  { id:10, name:"Sunita Sharma", mobile:"9844444444", password:"city@123",    role:"city_incharge",     hierarchyLevel:6,  roleLabel:"City Incharge",                      scopeLabel:"Jaipur City",                 zone_id:1, branch_id:1, avatar:"SS", dashboard:true,  modules:["agent","dcr"] },
  // L7 — Field Executive (DCR)
  { id:6,  name:"Anita Verma",   mobile:"5432109876", password:"dcr@123",     role:"executive",         hierarchyLevel:7,  roleLabel:"Field Executive (DCR)",              scopeLabel:"Jaipur Rural",                avatar:"AV", dashboard:false, modules:["dcr","survey"] },
  // L8 — Center Incharge
  { id:11, name:"Gopal Das",     mobile:"9855555555", password:"center@123",  role:"center_incharge",   hierarchyLevel:8,  roleLabel:"Center Incharge",                    scopeLabel:"Mansarovar Center",           avatar:"GD", dashboard:false, modules:["hawker"] },
  // L9 — Newspaper Agent
  { id:12, name:"Manoj Kumar",   mobile:"9866666666", password:"agent@123",   role:"agent",             hierarchyLevel:9,  roleLabel:"Newspaper Agent",                    scopeLabel:"MN Territory — 6 routes",     avatar:"MK", dashboard:false, modules:["agent"] },
  // L10 — Hawker
  { id:3,  name:"Suresh Kumar",  mobile:"8765432109", password:"hawker@123",  role:"hawker",            hierarchyLevel:10, roleLabel:"Hawker",                             scopeLabel:"Route MN-04",                 avatar:"SK", dashboard:false, modules:["hawker"] },
  // L7 variant — Survey Executive
  { id:4,  name:"Priya Singh",   mobile:"7654321098", password:"survey@123",  role:"executive",         hierarchyLevel:7,  roleLabel:"Survey Executive",                   scopeLabel:"Jodhpur City",                avatar:"PS", dashboard:false, modules:["survey"] },
  // L7 variant — Transport Executive
  { id:5,  name:"Rajan Patel",   mobile:"6543210987", password:"taxi@123",    role:"executive",         hierarchyLevel:7,  roleLabel:"Transport Executive",                scopeLabel:"Jaipur City",                 avatar:"RP", dashboard:false, modules:["taxi"] },
];

/* ---- copy pipeline (Dashboard reference: vitran) ---- */
const PIPE = [
  { k: "Planned", v: 412500 }, { k: "Printed", v: 411200 }, { k: "Dispatched", v: 410900 },
  { k: "Agency received", v: 408750 }, { k: "Hawker issued", v: 407900 }, { k: "Delivered", v: 400120 }
];

const DISTRICTS = [
  { name: "Jaipur",  planned: 112500, delivered: 109480, missed: 520, otd: 96.8, growth: 1.2,  out: 1840000 },
  { name: "Jodhpur", planned: 64200,  delivered: 62410,  missed: 310, otd: 97.2, growth: 0.8,  out: 920000 },
  { name: "Udaipur", planned: 48900,  delivered: 47630,  missed: 240, otd: 97.4, growth: 2.1,  out: 610000 },
  { name: "Kota",    planned: 52600,  delivered: 50980,  missed: 390, otd: 95.1, growth: -1.8, out: 1120000 },
  { name: "Sikar",   planned: 31400,  delivered: 30110,  missed: 480, otd: 92.6, growth: -3.4, out: 880000 }
];

const AGENCIES = [
  { name: "Shree Ganesh News Agency", area: "Malviya Nagar", owner: "Ramesh Agarwal", copies: 4820, otd: 97.1, out: 184200, score: 92, tier: "Gold",     routes: 6, hawkers: 14 },
  { name: "Jai Ambe Agencies",        area: "Vaishali Nagar", owner: "Sunita Sharma",  copies: 5340, otd: 97.9, out: 96500,  score: 95, tier: "Platinum", routes: 7, hawkers: 16 },
  { name: "Shivam Distributors",      area: "Mansarovar",     owner: "Mukesh Yadav",   copies: 6110, otd: 93.2, out: 412600, score: 71, tier: "Silver",   routes: 8, hawkers: 19 },
  { name: "Raghav News Point",        area: "Jhotwara",       owner: "Kailash Gurjar", copies: 3980, otd: 96.6, out: 151800, score: 86, tier: "Gold",     routes: 5, hawkers: 11 },
  { name: "Patrika Seva Kendra",      area: "C-Scheme",       owner: "Direct depot",   copies: 2860, otd: 98.0, out: 42100,  score: 97, tier: "Platinum", routes: 4, hawkers: 9 }
];

const ROUTES = [
  { id: "MN-01", hawker: "Mahesh Saini",           copies: 340, stops: 118, done: 118, missed: 1, status: "Completed",        window: "05:10–07:35" },
  { id: "MN-02", hawker: "Dinesh Prajapat",        copies: 412, stops: 141, done: 141, missed: 3, status: "Completed",        window: "05:05–07:52" },
  { id: "MN-03", hawker: "Substitute: Ravi Meena", copies: 298, stops: 104, done: 96,  missed: 2, status: "Out for delivery", window: "05:40–…" },
  { id: "MN-04", hawker: "Suresh Kumar",           copies: 365, stops: 126, done: 118, missed: 2, status: "Out for delivery", window: "05:12–…" },
  { id: "MN-05", hawker: "Om Prakash",             copies: 388, stops: 133, done: 133, missed: 4, status: "Completed",        window: "05:00–07:41" },
  { id: "MN-06", hawker: "Bhawani Singh",          copies: 301, stops: 109, done: 109, missed: 0, status: "Completed",        window: "05:18–07:29" }
];

const CUSTOMERS = [
  { id: "C-104822", name: "Anita Devi",             phone: "98871 20455", addr: "B-12 Girnar Colony, Gandhi Path, Jaipur", plan: "RP City · Monthly",          route: "MN-04", out: 0,    churn: "Low",    status: "Active" },
  { id: "C-104961", name: "R.K. Khandelwal",        phone: "94131 88012", addr: "B-14 Girnar Colony, Jaipur",              plan: "RP City + Plus · Annual",    route: "MN-04", out: 0,    churn: "Low",    status: "Active" },
  { id: "C-105233", name: "Meenakshi Jain",         phone: "99283 41077", addr: "B-19 Girnar Colony, Jaipur",              plan: "RP City · Monthly",          route: "MN-04", out: 360,  churn: "Medium", status: "Renewal due" },
  { id: "C-101778", name: "Gupta Dairy",            phone: "98290 66004", addr: "Shop 4, Gandhi Path Cross, Jaipur",       plan: "RP City ×6 · Bulk monthly",  route: "MN-04", out: 2160, churn: "Low",    status: "Active" },
  { id: "C-106410", name: "Farhan Ali",             phone: "97724 15532", addr: "D-8 Shanti Nagar, Jaipur",                plan: "RP City · Monthly",          route: "MN-04", out: 360,  churn: "High",   status: "Renewal due" },
  { id: "C-103902", name: "Pooja Agarwal",          phone: "98750 90218", addr: "E-3 Nemi Nagar, Jaipur",                  plan: "RP City + Plus · Monthly",   route: "MN-04", out: 475,  churn: "Medium", status: "Active" },
  { id: "C-102117", name: "Hotel Rajputana Palace", phone: "0141 237 0011", addr: "Palace Rd, C-Scheme, Jaipur",           plan: "RP City ×40 · Institutional",route: "CS-02", out: 0,    churn: "Low",    status: "Active" },
  { id: "C-107055", name: "Kavita Choudhary",       phone: "96023 78841", addr: "H-22 Officers Campus, Sikar Rd",          plan: "RP City · Monthly",          route: "JW-03", out: 720,  churn: "High",   status: "Paused" }
];

const COMPLAINTS = [
  { id: "T-88231", cust: "Farhan Ali",             cat: "Newspaper not delivered",        route: "MN-04", sla: "2h left",      slaState: "warn", pri: "High",   status: "Open" },
  { id: "T-88219", cust: "Sarla Poddar",           cat: "Late delivery (after 7:30)",     route: "MN-03", sla: "Breached 40m", slaState: "crit", pri: "High",   status: "Escalated" },
  { id: "T-88204", cust: "Hotel Rajputana Palace", cat: "Short supply — 4 of 40 copies",  route: "CS-02", sla: "6h left",      slaState: "good", pri: "Medium", status: "In progress" },
  { id: "T-88187", cust: "Meenakshi Jain",         cat: "Billing — charged after pause",  route: "MN-04", sla: "1d 4h left",   slaState: "good", pri: "Medium", status: "Open" },
  { id: "T-88160", cust: "N.D. Saxena",            cat: "Damaged copy (rain)",            route: "VN-01", sla: "Resolved",     slaState: "good", pri: "Low",    status: "Resolved" },
  { id: "T-88146", cust: "Kavita Choudhary",       cat: "Restart request after pause",    route: "JW-03", sla: "3h left",      slaState: "warn", pri: "Medium", status: "Open" }
];

const APPROVALS = [
  { id: "AP-2291", type: "Copy adjustment",     title: "+240 copies, Mansarovar (Shivam Distributors)",      req: "Mukesh Yadav",     amt: "240 copies", age: "38m",   pri: "High",   note: "Society event Sunday; bulk order from RWA. Variance above ±5% needs DMO approval." },
  { id: "AP-2289", type: "Refund",              title: "Refund ₹1,080 — C-107055 Kavita Choudhary",          req: "Customer service", amt: "₹1,080",     age: "2h",    pri: "Medium", note: "Paused 18 days in June, billed full month. Prorated refund per policy R-4." },
  { id: "AP-2286", type: "Settlement",          title: "June settlement — Shree Ganesh News Agency",         req: "Finance desk",     amt: "₹1,84,620",  age: "5h",    pri: "High",   note: "Net payable after commission ₹41,180 and copy charges. Agency acknowledged statement." },
  { id: "AP-2280", type: "Route transfer",      title: "Move 22 households MN-03 → MN-04",                   req: "Ramesh Agarwal",   amt: "22 customers", age: "1d",  pri: "Medium", note: "MN-03 over capacity since Shakti Nagar extension; MN-04 has headroom." },
  { id: "AP-2274", type: "Commission override", title: "Festival incentive +0.4% — Jai Ambe Agencies",       req: "DMO Jaipur",       amt: "+0.4% (Jul)", age: "1d 6h", pri: "Low",   note: "Teej campaign target exceeded 112%. Within DMO discretion band, needs RM counter-sign." }
];

const EXCEPTIONS = [
  { sev: "crit", t: "Vehicle RJ14-GA-2214 delayed 55 min — Sikar highway diversion", s: "Trip #T-4471 · 18,400 copies · ETA 06:10 → 07:05 · 3 agencies waiting", when: "05:42" },
  { sev: "crit", t: "Shivam Distributors short-received 240 copies", s: "Mansarovar · bundle count 5,870 vs manifest 6,110 · adjustment AP-2291 raised", when: "05:58" },
  { sev: "warn", t: "Hawker absent — Route MN-03 (Gopal Sharma, sick leave)", s: "Substitute Ravi Meena assigned by agency · route started 28 min late", when: "05:36" },
  { sev: "warn", t: "UPI settlement batch ₹48,200 unreconciled", s: "Gateway batch #U-8842 · 61 payments · bank credit not matched", when: "Since yesterday" },
  { sev: "info", t: "1,120 subscribers crossed churn-risk threshold", s: "Driver: renewal lapse >5 days + 2 missed deliveries in 30 days · win-back list ready", when: "04:00" }
];

const LEADS = { surveyed: 1240, interested: 412, trial: 186, offer: 97, converted: 64 };
const LEADLIST = [
  { name: "Sanjay Bhargava", phone: "98292 34110", area: "Nirman Nagar B", pub: "RP City",          stage: "Trial started",   next: "Trial ends 14 Jul — visit",   score: 82 },
  { name: "Ritu Saini",      phone: "94612 08834", area: "Nirman Nagar C", pub: "RP City + Plus",   stage: "Offer shared",    next: "Follow up today 5 pm",        score: 74 },
  { name: "Imran Qureshi",   phone: "97832 51190", area: "Shyam Nagar",    pub: "RP City",          stage: "Interested",      next: "Share monsoon offer",         score: 61 },
  { name: "Geeta Kanwar",    phone: "96945 77012", area: "Nirman Nagar B", pub: "RP City (Hindi)",  stage: "Payment pending", next: "Collect ₹360, activate",      score: 91 },
  { name: "Amit Khatri",     phone: "90014 62287", area: "Shyam Nagar",    pub: "Competitor reader",stage: "Surveyed",        next: "Revisit with comparison",     score: 44 }
];

const PAYMENTS = [
  { cust: "Gupta Dairy",      id: "C-101778", amt: 2160, due: "14 Jul",     route: "MN-04", status: "Due" },
  { cust: "Farhan Ali",       id: "C-106410", amt: 360,  due: "14 Jul",     route: "MN-04", status: "Due" },
  { cust: "Pooja Agarwal",    id: "C-103902", amt: 475,  due: "16 Jul",     route: "MN-04", status: "Due" },
  { cust: "Meenakshi Jain",   id: "C-105233", amt: 360,  due: "Overdue 3d", route: "MN-04", status: "Overdue" },
  { cust: "Kavita Choudhary", id: "C-107055", amt: 720,  due: "Overdue 9d", route: "JW-03", status: "Overdue" }
];
const RECEIPTS = [
  { no: "R-99120", cust: "Anita Devi",             amt: 360,   mode: "UPI",           by: "Suresh Kumar",     at: "06:14 today" },
  { no: "R-99118", cust: "Col. V.S. Shekhawat",    amt: 1080,  mode: "Cash",          by: "Suresh Kumar",     at: "06:02 today" },
  { no: "R-99105", cust: "Hotel Rajputana Palace", amt: 14400, mode: "Bank transfer", by: "Direct / gateway", at: "Yesterday" }
];

const SETTLEMENT = {
  partner: "Shree Ganesh News Agency", period: "June 2026", status: "Awaiting approval",
  lines: [["Opening balance", -12400], ["Copy charges (1,41,300 copies @ ₹3.86 avg)", -545420], ["Collections deposited", 512260], ["Commission (12.4% blended)", 41180], ["Teej campaign incentive", 6500], ["Returns credit (2,140 copies)", 8260], ["Penalty — 2 SLA breaches", -1500], ["TDS", -2260]],
  net: 6620
};

const TRIPS = [
  { id: "T-4468", veh: "RJ14-GA-1181",     driver: "Shafiq Khan",          load: "22,600", route: "Press → Malviya Ngr → Sanganer", dep: "04:10", eta: "05:20", status: "Completed",  delay: 0,  kms: 38 },
  { id: "T-4471", veh: "RJ14-GA-2214",     driver: "Bhanwar Lal",          load: "18,400", route: "Press → Sikar Rd corridor",      dep: "04:05", eta: "06:10", status: "Delayed",    delay: 55, kms: 92 },
  { id: "T-4473", veh: "RJ14-PA-0977",     driver: "Nathu Singh",          load: "15,900", route: "Press → Vaishali → Jhotwara",    dep: "04:18", eta: "05:35", status: "Completed",  delay: 6,  kms: 31 },
  { id: "T-4476", veh: "Taxi RJ14-TA-3321",driver: "Vendor: Marudhar Cabs",load: "4,200",  route: "Press → Chomu → Samod",          dep: "04:30", eta: "06:25", status: "In transit", delay: 0,  kms: 74 }
];
const VEHICLES = [
  { no: "RJ14-GA-1181", type: "LCV — 2.5T",  driver: "Shafiq Khan", fitness: "Mar 2027", insurance: "Nov 2026", status: "On trip" },
  { no: "RJ14-GA-2214", type: "LCV — 3.5T",  driver: "Bhanwar Lal", fitness: "Jan 2027", insurance: "Aug 2026", status: "Delayed" },
  { no: "RJ14-PA-0977", type: "Pickup — 1T", driver: "Nathu Singh", fitness: "Jun 2027", insurance: "Feb 2027", status: "Idle" },
  { no: "RJ14-TA-3321", type: "Taxi (vendor)", driver: "Marudhar Cabs", fitness: "—",    insurance: "Vendor",   status: "On trip" }
];

/* ---- agency (Agent App) ---- */
const SUPPLY = [
  { pub: "Rajasthan Patrika City", supply: 4820, rate: 3.86 },
  { pub: "Patrika Plus",           supply: 310,  rate: 2.40 },
  { pub: "Catch (weekly)",         supply: 96,   rate: 2.00 }
];
const LEDGER = [
  ["14 Jul", "Supply — 4,820 copies @ slab", "₹18,606", "—", "₹1,84,200 Dr"],
  ["13 Jul", "Supply — 4,810 copies",        "₹18,567", "—", "₹1,65,594 Dr"],
  ["12 Jul", "Collections deposited",         "—", "₹22,400", "₹1,47,027 Dr"],
  ["09 Jul", "NEFT payment received",         "—", "₹50,000", "₹1,69,427 Dr"],
  ["03 Jul", "June commission credited",      "—", "₹41,180", "₹2,19,427 Dr"],
  ["01 Jul", "June bill — 1,41,300 copies",   "₹5,45,420", "—", "₹2,60,607 Dr"]
];

/* ---- hawker route stops ---- */
const STOPS = [
  { n: 1,  name: "Anita Devi",              addr: "B-12 Girnar Colony, Gandhi Path", pubs: "RP City",        st: "done",    collect: 0 },
  { n: 2,  name: "R.K. Khandelwal",         addr: "B-14 Girnar Colony",              pubs: "RP City + Plus", st: "done",    collect: 0 },
  { n: 3,  name: "Meenakshi Jain",          addr: "B-19 Girnar Colony",              pubs: "RP City",        st: "done",    collect: 360 },
  { n: 4,  name: "Col. V.S. Shekhawat",     addr: "C-2 Shanti Nagar",                pubs: "RP City",        st: "done",    collect: 0 },
  { n: 5,  name: "Gupta Dairy (bulk ×6)",   addr: "Shop 4, Gandhi Path Cross",       pubs: "RP City ×6",     st: "done",    collect: 2160 },
  { n: 6,  name: "Farhan Ali",              addr: "D-8 Shanti Nagar",                pubs: "RP City",        st: "pending", collect: 360 },
  { n: 7,  name: "S. Venkatesan",           addr: "D-11 Shanti Nagar",               pubs: "RP City",        st: "pending", collect: 0 },
  { n: 8,  name: "Pooja Agarwal",           addr: "E-3 Nemi Nagar",                  pubs: "RP City + Plus", st: "pending", collect: 475 },
  { n: 9,  name: "Harish Chandnani",        addr: "E-9 Nemi Nagar",                  pubs: "RP City",        st: "pending", collect: 0 },
  { n: 10, name: "Dr. Nidhi Bhatnagar",     addr: "F-1 Nemi Nagar, Flat 302",        pubs: "RP City",        st: "pending", collect: 360 }
];

/* ---- DCR field visit plan ---- */
const TOUR = [
  { time: "09:00", type: "Agency visit",   target: "Shivam Distributors — Mansarovar",  why: "Short-receipt follow-up · outstanding ₹4.1 L" },
  { time: "11:30", type: "Hawker visit",   target: "Gopal Sharma (MN-03)",              why: "Absence pattern · substitute quality check" },
  { time: "13:00", type: "New area survey",target: "Nemi Nagar extension",              why: "62 unserved households · route gap from optimiser" },
  { time: "16:00", type: "Reader visit",   target: "Hotel Rajputana Palace (bulk ×40)", why: "Short supply ticket T-88204 · retention call" }
];

const REPORTS_CAT = [
  ["Circulation",           ["Daily copy pipeline", "Edition-wise circulation", "Variance vs plan", "Returns analysis"]],
  ["Collections & finance", ["Collection summary", "Outstanding ageing", "Reconciliation status", "Revenue per copy"]],
  ["Customers",             ["Renewals due", "Churn-risk cohort", "New acquisitions", "Data-quality gaps"]],
  ["Partners",              ["Partner scorecards", "Settlement register", "Commission payout", "Loyalty ledger"]],
  ["Service",               ["Complaint SLA", "Repeat complaints", "Root-cause pareto", "CSAT"]],
  ["Logistics",             ["Trip cost per copy", "Vehicle utilisation", "Delay analysis", "Compliance expiry"]]
];

const MASTERS = [
  { title: "Publications & editions", desc: "Rajasthan Patrika, Patrika Plus, Patrika Deep, Catch — editions & pricing", icon: "📰" },
  { title: "Geography hierarchy",     desc: "State → District → Territory → Route mapping",                              icon: "🗺️" },
  { title: "Pricing & plans",         desc: "Monthly, annual, bulk & trial subscription plans",                           icon: "🏷️" },
  { title: "Commission rules",        desc: "Agency slabs, hawker incentives, penalties",                                 icon: "💰" },
  { title: "Roles & permissions",     desc: "Role-based module access across the suite",                                  icon: "🔐" },
  { title: "Workflows & approvals",   desc: "Approval chains, SLAs and escalation rules",                                 icon: "🔁" },
  { title: "Notification templates",  desc: "WhatsApp / SMS templates in Hindi & English",                                icon: "💬" },
  { title: "Audit & security",        desc: "Full audit trail of user and system actions",                                icon: "🛡️" }
];

/* ---- Hierarchy drilldown data ---- */
const ZONES_DATA = [
  { id:1, name:"Rajasthan", region:"Rajasthan",      branches:15, agencies:92,  copies_plan:329300, copies_del:323600, missed:5700,  otd:95.8, collected:19600000, due:24570000, out:4970000, complaints:79  },
  { id:2, name:"MP",        region:"Madhya Pradesh",  branches:8,  agencies:34,  copies_plan:99200,  copies_del:96100,  missed:3100,  otd:93.1, collected:5900000,  due:7790000,  out:1890000, complaints:22  },
  { id:3, name:"CG",        region:"Chhattisgarh",    branches:3,  agencies:16,  copies_plan:74800,  copies_del:71200,  missed:3600,  otd:91.4, collected:4200000,  due:5650000,  out:1450000, complaints:17  },
  { id:4, name:"National",  region:"Multi-state",     branches:7,  agencies:22,  copies_plan:86200,  copies_del:83900,  missed:2300,  otd:97.2, collected:5250000,  due:6465000,  out:1215000, complaints:12  },
];

const BRANCHES_DATA = [
  // Rajasthan — 15 units
  { id:1,  zone_id:1, name:"JAIPUR RP",        city:"Jaipur",         agencies:18, copies_plan:68000, copies_del:67200, missed:800,  otd:97.3, collected:4200000, due:5100000, out:900000,  complaints:12 },
  { id:2,  zone_id:1, name:"JODHPUR RP",        city:"Jodhpur",        agencies:12, copies_plan:42000, copies_del:41200, missed:800,  otd:97.1, collected:2600000, due:3200000, out:600000,  complaints:8  },
  { id:3,  zone_id:1, name:"KOTA RP",           city:"Kota",           agencies:8,  copies_plan:28000, copies_del:27400, missed:600,  otd:97.1, collected:1700000, due:2100000, out:400000,  complaints:5  },
  { id:4,  zone_id:1, name:"UDAIPUR RP",        city:"Udaipur",        agencies:7,  copies_plan:25000, copies_del:24400, missed:600,  otd:96.8, collected:1500000, due:1900000, out:400000,  complaints:5  },
  { id:5,  zone_id:1, name:"AJMER RP",          city:"Ajmer",          agencies:7,  copies_plan:24000, copies_del:23400, missed:600,  otd:96.8, collected:1400000, due:1800000, out:400000,  complaints:4  },
  { id:6,  zone_id:1, name:"BIKANER RP",        city:"Bikaner",        agencies:6,  copies_plan:22000, copies_del:21400, missed:600,  otd:96.6, collected:1300000, due:1600000, out:300000,  complaints:5  },
  { id:7,  zone_id:1, name:"ALWAR RP",          city:"Alwar",          agencies:6,  copies_plan:20000, copies_del:19500, missed:500,  otd:96.4, collected:1200000, due:1500000, out:300000,  complaints:3  },
  { id:8,  zone_id:1, name:"SIKAR RP",          city:"Sikar",          agencies:5,  copies_plan:18000, copies_del:17500, missed:500,  otd:96.2, collected:1100000, due:1350000, out:250000,  complaints:3  },
  { id:9,  zone_id:1, name:"BHILWARA RP",       city:"Bhilwara",       agencies:5,  copies_plan:16000, copies_del:15500, missed:500,  otd:96.1, collected:950000,  due:1200000, out:250000,  complaints:3  },
  { id:10, zone_id:1, name:"BARMER RP",         city:"Barmer",         agencies:4,  copies_plan:14000, copies_del:13500, missed:500,  otd:96.0, collected:850000,  due:1050000, out:200000,  complaints:3  },
  { id:11, zone_id:1, name:"PALI RP",           city:"Pali",           agencies:3,  copies_plan:12000, copies_del:11600, missed:400,  otd:96.1, collected:720000,  due:900000,  out:180000,  complaints:2  },
  { id:12, zone_id:1, name:"SRI GANGANAGAR RP", city:"Sri Ganganagar", agencies:3,  copies_plan:12000, copies_del:11600, missed:400,  otd:96.1, collected:720000,  due:900000,  out:180000,  complaints:2  },
  { id:13, zone_id:1, name:"JHUNJHUNU",         city:"Jhunjhunu",      agencies:3,  copies_plan:10000, copies_del:9700,  missed:300,  otd:96.3, collected:600000,  due:750000,  out:150000,  complaints:2  },
  { id:14, zone_id:1, name:"BHARATPUR RP",      city:"Bharatpur",      agencies:3,  copies_plan:10000, copies_del:9700,  missed:300,  otd:96.1, collected:600000,  due:750000,  out:150000,  complaints:2  },
  { id:15, zone_id:1, name:"BANSWARA RP",       city:"Banswara",       agencies:2,  copies_plan:8300,  copies_del:8100,  missed:200,  otd:96.2, collected:500000,  due:620000,  out:120000,  complaints:2  },
  // MP — 8 units
  { id:16, zone_id:2, name:"INDORE PT",         city:"Indore",         agencies:8,  copies_plan:22000, copies_del:21200, missed:800,  otd:93.8, collected:1290000, due:1750000, out:460000,  complaints:6  },
  { id:17, zone_id:2, name:"BHOPAL PT",         city:"Bhopal",         agencies:7,  copies_plan:20000, copies_del:19300, missed:700,  otd:93.5, collected:1170000, due:1600000, out:430000,  complaints:5  },
  { id:18, zone_id:2, name:"GWALIOR PT",        city:"Gwalior",        agencies:5,  copies_plan:14000, copies_del:13400, missed:600,  otd:93.4, collected:820000,  due:1100000, out:280000,  complaints:4  },
  { id:19, zone_id:2, name:"JABALPUR PT",       city:"Jabalpur",       agencies:4,  copies_plan:13000, copies_del:12500, missed:500,  otd:93.4, collected:760000,  due:1020000, out:260000,  complaints:3  },
  { id:20, zone_id:2, name:"SAGAR PT",          city:"Sagar",          agencies:3,  copies_plan:10000, copies_del:9600,  missed:400,  otd:93.1, collected:585000,  due:780000,  out:195000,  complaints:2  },
  { id:21, zone_id:2, name:"SATNA PT",          city:"Satna",          agencies:3,  copies_plan:8000,  copies_del:7700,  missed:300,  otd:93.0, collected:468000,  due:625000,  out:157000,  complaints:1  },
  { id:22, zone_id:2, name:"CHHINDWARA PT",     city:"Chhindwara",     agencies:2,  copies_plan:7000,  copies_del:6700,  missed:300,  otd:92.7, collected:410000,  due:548000,  out:138000,  complaints:1  },
  { id:23, zone_id:2, name:"KHANDWA PT",        city:"Khandwa",        agencies:2,  copies_plan:5200,  copies_del:4700,  missed:500,  otd:92.3, collected:307000,  due:410000,  out:103000,  complaints:0  },
  // CG — 3 units
  { id:24, zone_id:3, name:"RAIPUR PT",         city:"Raipur",         agencies:7,  copies_plan:38000, copies_del:36400, missed:1600, otd:91.4, collected:2240000, due:3000000, out:760000,  complaints:10 },
  { id:25, zone_id:3, name:"BILASPUR PT",       city:"Bilaspur",       agencies:5,  copies_plan:22000, copies_del:20800, missed:1200, otd:90.7, collected:1290000, due:1740000, out:450000,  complaints:5  },
  { id:26, zone_id:3, name:"JAGDALPUR PT",      city:"Jagdalpur",      agencies:4,  copies_plan:14800, copies_del:14000, missed:800,  otd:90.8, collected:870000,  due:1150000, out:280000,  complaints:2  },
  // National — 7 units
  { id:27, zone_id:4, name:"DELHI PT",          city:"Delhi",          agencies:6,  copies_plan:28000, copies_del:27200, missed:800,  otd:97.1, collected:1700000, due:2100000, out:400000,  complaints:5  },
  { id:28, zone_id:4, name:"AHMEDABAD RP",      city:"Ahmedabad",      agencies:4,  copies_plan:16000, copies_del:15600, missed:400,  otd:97.5, collected:970000,  due:1200000, out:230000,  complaints:2  },
  { id:29, zone_id:4, name:"BANGLORE RP",       city:"Bangalore",      agencies:3,  copies_plan:13000, copies_del:12700, missed:300,  otd:97.7, collected:790000,  due:970000,  out:180000,  complaints:1  },
  { id:30, zone_id:4, name:"KOLKATA RP",        city:"Kolkata",        agencies:3,  copies_plan:10000, copies_del:9700,  missed:300,  otd:97.0, collected:610000,  due:750000,  out:140000,  complaints:2  },
  { id:31, zone_id:4, name:"SURAT RP",          city:"Surat",          agencies:2,  copies_plan:8000,  copies_del:7800,  missed:200,  otd:97.5, collected:490000,  due:600000,  out:110000,  complaints:1  },
  { id:32, zone_id:4, name:"HUBLI RP",          city:"Hubli",          agencies:2,  copies_plan:6500,  copies_del:6300,  missed:200,  otd:96.9, collected:400000,  due:490000,  out:90000,   complaints:1  },
  { id:33, zone_id:4, name:"CHENNAI RP",        city:"Chennai",        agencies:2,  copies_plan:4700,  copies_del:4600,  missed:100,  otd:97.9, collected:290000,  due:355000,  out:65000,   complaints:0  },
];

const AGENCIES_DATA = [
  { id:"ag1",  branch_id:1, name:"Shree Ganesh News Agency", area:"Malviya Nagar",  owner:"Ramesh Agarwal",  copies_plan:4850, copies_del:4820, missed:30,  otd:97.1, collected:384200, due:568400, out:184200, complaints:4, score:92, tier:"Gold"     },
  { id:"ag2",  branch_id:1, name:"Jai Ambe Agencies",        area:"Vaishali Nagar", owner:"Sunita Sharma",   copies_plan:5350, copies_del:5340, missed:10,  otd:97.9, collected:503500, due:600000, out:96500,  complaints:2, score:95, tier:"Platinum" },
  { id:"ag3",  branch_id:1, name:"Shivam Distributors",      area:"Mansarovar",     owner:"Mukesh Yadav",    copies_plan:6350, copies_del:6110, missed:240, otd:93.2, collected:512800, due:925400, out:412600, complaints:8, score:71, tier:"Silver"   },
  { id:"ag4",  branch_id:1, name:"Raghav News Point",        area:"Jhotwara",       owner:"Kailash Gurjar",  copies_plan:3990, copies_del:3980, missed:10,  otd:96.6, collected:290200, due:442000, out:151800, complaints:3, score:86, tier:"Gold"     },
  { id:"ag5",  branch_id:1, name:"Patrika Seva Kendra",      area:"C-Scheme",       owner:"Direct depot",    copies_plan:2860, copies_del:2860, missed:0,   otd:98.0, collected:157900, due:200000, out:42100,  complaints:1, score:97, tier:"Platinum" },
  { id:"ag6",  branch_id:2, name:"Durgesh News Agency",      area:"Sanganer",       owner:"Durgesh Pareek",  copies_plan:5200, copies_del:5050, missed:150, otd:94.8, collected:460000, due:540000, out:80000,  complaints:5, score:83, tier:"Gold"     },
  { id:"ag7",  branch_id:2, name:"Om Shanti Agencies",       area:"Jagatpura",      owner:"Prashant Verma",  copies_plan:3800, copies_del:3720, missed:80,  otd:95.2, collected:340000, due:400000, out:60000,  complaints:3, score:78, tier:"Silver"   },
  { id:"ag8",  branch_id:2, name:"Balaji Distributors",      area:"Sodala",         owner:"Hemant Jain",     copies_plan:4100, copies_del:3980, missed:120, otd:93.8, collected:380000, due:455000, out:75000,  complaints:4, score:75, tier:"Silver"   },
  { id:"ag9",  branch_id:3, name:"Marwar News Point",        area:"Sardarpura",     owner:"Govind Das",      copies_plan:5500, copies_del:5320, missed:180, otd:94.1, collected:490000, due:600000, out:110000, complaints:6, score:80, tier:"Gold"     },
  { id:"ag10", branch_id:3, name:"Jodhpur City Agency",      area:"Paota",          owner:"Arjun Bishnoi",   copies_plan:4200, copies_del:4050, missed:150, otd:93.8, collected:380000, due:470000, out:90000,  complaints:4, score:77, tier:"Silver"   },
  { id:"ag11", branch_id:3, name:"Suncity Distributors",     area:"Shastri Nagar",  owner:"Nirmala Sharma",  copies_plan:3800, copies_del:3600, missed:200, otd:92.1, collected:310000, due:380000, out:70000,  complaints:5, score:72, tier:"Silver"   },
  { id:"ag12", branch_id:4, name:"Ajmer News Agency",        area:"Beawar Road",    owner:"Suresh Pilania",  copies_plan:4100, copies_del:4020, missed:80,  otd:96.1, collected:340000, due:390000, out:50000,  complaints:3, score:85, tier:"Gold"     },
  { id:"ag13", branch_id:4, name:"Pushkar Distributors",     area:"Nasirabad",      owner:"Ramesh Vyas",     copies_plan:3600, copies_del:3480, missed:120, otd:95.2, collected:290000, due:340000, out:50000,  complaints:2, score:82, tier:"Gold"     },
];
