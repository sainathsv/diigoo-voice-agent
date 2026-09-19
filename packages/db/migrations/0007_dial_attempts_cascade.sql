-- 0007 dial_attempts belongs to a tenant like everything else: deleting a client
-- (offboarding, DPDP erasure) must remove its dial log too.
alter table dial_attempts
  add constraint dial_attempts_tenant_fk foreign key (tenant_id) references organizations(id) on delete cascade;
