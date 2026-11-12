// Only call after the disposable loopback test URL has been validated.
export async function seedStopProof(sql: any, stopId: number, actorId = 3) {
    const id = crypto.randomUUID();
    await sql`insert into driver_stop_proofs(id,stop_id,actor_id,operation_key,kind,storage_key,content_type,sha256,byte_size)
      values(${id},${stopId},${actorId},${crypto.randomUUID()},'photo',${`fixture/${id}`},'image/webp','fixture',1)`;
}

export async function seedDriverFixture(sql: any) {
    await sql`truncate users, warehouses, products, inventory, settings restart identity cascade`;
    const hash = await Bun.password.hash("fixture-password", { algorithm: "bcrypt", cost: 4 });
    await sql`insert into users(email,name,password_hash,role,created_at,updated_at) values
      ('admin@example.test','Admin',${hash},'admin',0,0),('staff@example.test','Staff',${hash},'staff',0,0),
      ('driver1@example.test','Driver 1',${hash},'driver',0,0),('driver2@example.test','Driver 2',${hash},'driver',0,0),
      ('customer@example.test','Customer',${hash},'customer',0,0)`;
    await sql`insert into warehouses(name,street_address,city,state,zip_code,latitude,longitude,created_at,updated_at) values
      ('North','Street','City','Province','0000',14.5,121,0,0),('South','Street','City','Province','0000',14.6,121.1,0,0)`;
    await sql`insert into staffs(user_id,warehouse_id) values(2,1)`;
    await sql`insert into drivers(user_id,warehouse_id,phone_number) values(3,1,'09000000001'),(4,2,'09000000002')`;
    await sql`insert into customers(user_id,company_name,phone_number) values(5,'Company','09000000000')`;
    await sql`insert into vehicles(warehouse_id,plate_number,type,created_at,updated_at) values(1,'AAA-001','truck',0,0),(2,'BBB-002','van',0,0)`;
    await sql`insert into products(name) values('Product')`;
    await sql`insert into product_variants(product_id,name,sku,price,unit) values(1,'Variant','SKU',99,'piece')`;
    await sql`insert into inventory(warehouse_id,product_id,product_variant_id,quantity,reserved,created_at,updated_at) values(1,1,1,10,2,0,0),(2,1,1,10,2,0,0)`;
    await sql`insert into orders(order_number,warehouse_id,customer_id,status,stock_reserved,payment_arrangement,shipping_recipient,shipping_phone,shipping_address,shipping_latitude,shipping_longitude)
      values('ORDER-1',1,1,'SCHEDULING',true,'PAY_ON_DELIVERY','Recipient','09000000000','Saved address',14.55,121.05),
      ('ORDER-2',2,1,'SCHEDULING',true,'NET_30','Recipient','09000000000','Other warehouse',14.65,121.15)`;
    await sql`insert into order_items(order_id,inventory_id,quantity,unit_price_snapshot,price_source) values(1,1,2,12.34,'fixture'),(2,2,2,12.34,'fixture')`;
}
