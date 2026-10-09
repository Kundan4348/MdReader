-- Open orders
select o.id, o.total
from orders o
where o.state = 'open';

-- Big customers
select c.name, sum(o.total) as spend
from customers c
join orders o on o.customer_id = c.id
group by c.name
order by spend desc;
