-- =====================================================
-- تأمين عملية تسجيل الحضور (الخطة 1)
-- نفّذ هذا الملف بالكامل في: Supabase Dashboard -> SQL Editor -> New query -> Run
-- =====================================================

-- 1) دالة آمنة وذرّية لتسجيل الحضور
--    SECURITY DEFINER تجعلها تعمل بصلاحيات مالك الدالة (postgres)
--    وبالتالي تتجاوز RLS بأمان لتنفيذ منطق التحقق والتحديث معاً
create or replace function public.check_in_invitation(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inv record;
  v_now timestamptz := now();
  v_updated_at timestamptz;
begin
  -- جلب بيانات الدعوة + اسم الطالب
  select i.student_id, i.inv_num, i.used, i.used_at, s.name as student_name
    into v_inv
    from invitations i
    left join students s on s.id = i.student_id
    where i.code = p_code;

  -- الكود غير موجود
  if not found then
    return jsonb_build_object('status', 'invalid');
  end if;

  -- مستخدم مسبقاً
  if v_inv.used then
    return jsonb_build_object(
      'status', 'duplicate',
      'student_id', v_inv.student_id,
      'name', coalesce(v_inv.student_name, '—'),
      'inv_num', v_inv.inv_num,
      'used_at', v_inv.used_at
    );
  end if;

  -- تحديث ذرّي: ينجح فقط لو ما زال used = false (يمنع تكرار التسجيل عند التزامن)
  update invitations
    set used = true, used_at = v_now
    where code = p_code and used = false
    returning used_at into v_updated_at;

  if v_updated_at is null then
    -- سبق وفاز مسح آخر بنفس اللحظة بتسجيل الحضور
    return jsonb_build_object(
      'status', 'duplicate',
      'student_id', v_inv.student_id,
      'name', coalesce(v_inv.student_name, '—'),
      'inv_num', v_inv.inv_num,
      'used_at', v_now
    );
  end if;

  return jsonb_build_object(
    'status', 'success',
    'student_id', v_inv.student_id,
    'name', coalesce(v_inv.student_name, '—'),
    'inv_num', v_inv.inv_num,
    'used_at', v_updated_at
  );
end;
$$;

-- السماح لأي زائر (anon) وللمسجلين (authenticated) باستدعاء الدالة فقط
grant execute on function public.check_in_invitation(text) to anon, authenticated;


-- 2) منع تعليم أي دعوة كـ "مستخدمة" مباشرة عبر API
--    (يبقى السماح بإعادة تصفير الحضور used=false من لوحة التحكم كما هو)
--    أي طلب مباشر (PATCH) يحاول تعيين used = true سيُرفض من قاعدة البيانات،
--    ولن يُسمح بذلك إلا عبر الدالة check_in_invitation أعلاه
drop policy if exists "Block direct check-in" on public.invitations;

create policy "Block direct check-in"
on public.invitations
as restrictive
for update
to public
with check (used = false);
