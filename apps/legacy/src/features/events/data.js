export const ALLOCATE_TOPICS = [
  { id:'at_rent',   name:'Rent',          icon:'house',  allocated:740,  actual:740.00, estimate:740,  cats:['housingRent'],                       group:'recurring' },
  { id:'at_energy', name:'Energy',         icon:'flame',  allocated:65,   actual:65.00,  estimate:65,   cats:['housingUtility'],                    group:'recurring' },
  { id:'at_subs',   name:'Subscriptions',  icon:'film',   allocated:25,   actual:23.98,  estimate:25,   cats:['subs'],                              group:'recurring' },
  { id:'at_food',   name:'Food & Dining',  icon:'fork',   allocated:280,  actual:290.30, estimate:310,  cats:['groceries','restaurants','coffee'],   group:'var' },
  { id:'at_trans',  name:'Transport',      icon:'car',    allocated:80,   actual:50.40,  estimate:75,   cats:['transportPublic','transportCar','transportFuel'], group:'var' },
  { id:'at_health', name:'Health',         icon:'health', allocated:40,   actual:22.70,  estimate:35,   cats:['healthcare','doctorVisit','prescription'], group:'var' },
  { id:'at_hobby',  name:'Hobby',          icon:'bag',    allocated:110,  actual:79.99,  estimate:150,  cats:['hobby','videoGame','sportsEquipment'], group:'var' },
];

export const EVENTS = [
  { id: 'e1', name: 'Lisbon trip 2025',     start: '2025-09-12', end: '2025-09-19', total: 1186.30, txCount: 28, status: 'closed',   icon: 'globe', photo: 'https://images.unsplash.com/photo-1555881400-74d7acaacd8b?w=600&h=260&fit=crop' },
  { id: 'e2', name: 'Anna · Birthday',      start: '2026-01-30', end: '2026-02-02', total: 312.40,  txCount: 9,  status: 'closed',   icon: 'star',  photo: 'https://images.unsplash.com/photo-1527529482837-4698179dc6ce?w=600&h=260&fit=crop' },
  { id: 'e3', name: 'Berlin weekend',       start: '2026-02-21', end: '2026-02-23', total: 0,       txCount: 0,  status: 'upcoming', icon: 'globe', photo: 'https://images.unsplash.com/photo-1560930950-5cc20e80e392?w=600&h=260&fit=crop' },
];