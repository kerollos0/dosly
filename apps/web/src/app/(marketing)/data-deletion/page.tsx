import { COMPANY } from '@/lib/company';
import type { Metadata } from 'next';
import { Legal } from '../legal';

export const metadata: Metadata = { title: 'حذف البيانات' };

export default function DataDeletion() {
  return (
    <Legal title="حذف البيانات" updated="2026-11-20">
      <p>تقدر في أي وقت تطلب حذف بياناتك من دوسلي.</p>
      <h2>لو إنت وكالة</h2>
      <ul>
        <li>ابعت طلب الحذف من إيميل صاحب الحساب لـ <a href={`mailto:${COMPANY.supportEmail}`} dir="ltr" className="underline">{COMPANY.supportEmail}</a> واكتب اسم الوكالة.</li>
        <li>هنأكد الطلب، وبعدها نمسح كل بيانات الوكالة (الفريق، العملاء، الرسايل، البوستات، ومفاتيح الربط) خلال 30 يوم.</li>
        <li>النسخ الاحتياطية بتتمسح لوحدها خلال 7 أيام بعد كده.</li>
      </ul>
      <h2>لو إنت عميل بعت رسالة لبيزنس بيستخدم دوسلي</h2>
      <p>رسايلك ملك البيزنس اللي كلمته. اطلب منه الحذف، أو ابعتلنا على <a href={`mailto:${COMPANY.supportEmail}`} dir="ltr" className="underline">{COMPANY.supportEmail}</a> برقم موبايلك واسم البيزنس، وهنوصّل الطلب ونمسح الرسايل.</p>
      <h2>لو فصلت دوسلي من فيسبوك</h2>
      <p>لما تشيل صلاحيات دوسلي من إعدادات فيسبوك، المفاتيح بتاعتك بتبطل تشتغل فورًا، وتقدر تطلب مسحها نهائيًا بنفس الطريقة اللي فوق.</p>
    </Legal>
  );
}
