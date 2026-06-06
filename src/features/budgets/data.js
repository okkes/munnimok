export const BUDGETS = [
  { id:'b1', name:'Restaurants',  icon:'fork',   spent:95.40,  total:120, period:'Weekly',   periodDays:7,  renew:'every week',    cats:['restaurants','coffee'], stack:false },
  { id:'b2', name:'Groceries',    icon:'shop',   spent:164.80, total:300, period:'Monthly',  periodDays:30, renew:'every month',   cats:['groceries'], stack:true, stackMax:600, stackCur:30 },
  { id:'b3', name:'Transport',    icon:'car',    spent:74.80,  total:80,  period:'Monthly',  periodDays:30, renew:'every month',   cats:['transportPublic','transportCar','transportFuel'], stack:false },
  { id:'b4', name:'Hobby',        icon:'bag',    spent:204.99, total:200, period:'2 weeks',  periodDays:14, renew:'every 2 weeks', cats:['hobby','videoGame','sportsEquipment'], stack:false },
  { id:'b5', name:'Coffee runs',  icon:'flame',  spent:18.00,  total:60,  period:'3 weeks',  periodDays:21, renew:'every 3 weeks', cats:['coffee'], stack:true, stackMax:120, stackCur:42 },
  { id:'b6', name:'Health',       icon:'health', spent:36.70,  total:40,  period:'Monthly',  periodDays:30, renew:'every month',   cats:['healthcare','doctorVisit','prescription','dental'], stack:false },
  { id:'b7', name:'Subscriptions',icon:'film',   spent:23.98,  total:32,  period:'Monthly',  periodDays:30, renew:'every month',   cats:['subs'], stack:false },
  { id:'b8', name:'Nightlife',    icon:'star',   spent:87.50,  total:60,  period:'Monthly',  periodDays:30, renew:'every month',   cats:['restaurants'], stack:false },
];