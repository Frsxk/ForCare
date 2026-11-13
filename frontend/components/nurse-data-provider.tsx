"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { CheckCircle2 } from "lucide-react";
import Image from "next/image";
import { nurse } from "@/lib/dashboard-data";
import { initialNotificationPreferences, initialNotifications, type NurseNotification, type NotificationPreferences, type NotificationSetting } from "@/lib/notification-data";
import {
  homecareRequests,
  type HomecareRequest,
  type RequestStatus,
} from "@/lib/dashboard-data";
import { initialVisits, visitDemoDate, type NurseVisit } from "@/lib/visit-data";
import { patientDirectory, type PatientRisk } from "@/lib/patient-directory-data";
import { initialPatientHistories, isValidPatientHistory, type PatientMedicalHistory, type PatientAssessment } from "@/lib/patient-record-data";
import {
  initialMedicalRecords,
  initialVisitDrafts,
  getRecordCompleteness,
  type VisitMedicalRecord,
} from "@/lib/visit-medical-record";

type NurseData = {
  patientHistories: Record<string, PatientMedicalHistory>;
  savePatientHistory: (patientId: string, history: PatientMedicalHistory) => boolean;
  patientAssessments: Record<string, PatientAssessment>;
  approvePatientAssessment: (patientId: string, assessment: PatientAssessment) => boolean;
  notificationPreferences: NotificationPreferences;
  setNotificationPreference: (setting: NotificationSetting, enabled: boolean) => void;
  unreadNotificationCount: number;
  signOutDemo: () => void;
  riskReviews: Record<string, PatientRisk>;
  approvePatientRisk: (patientId: string, risk: PatientRisk) => void;
  visits: NurseVisit[];
  medicalRecords: Record<string, VisitMedicalRecord>;
  visitDrafts: Record<string, VisitMedicalRecord>;
  saveVisitDraft: (visitId: string, record: VisitMedicalRecord) => boolean;
  saveMedicalRecord: (visitId: string, record: VisitMedicalRecord) => boolean;
  requests: HomecareRequest[];
  decideRequest: (
    id: string,
    status: Exclude<RequestStatus, "pending">,
    reason?: string,
  ) => void;
  reviewedPatients: string[];
  reviewPatient: (id: string) => void;
  notifications: NurseNotification[];
  markNotificationRead: (notificationId: string) => void;
  markNotificationsRead: () => void;
  notify: (message: string) => void;
};

const NurseDataContext = createContext<NurseData | null>(null);

export function NurseDataProvider({ children }: { children: ReactNode }) {
  const [patientHistories, setPatientHistories] = useState(initialPatientHistories);
  const [patientAssessments, setPatientAssessments] = useState<Record<string, PatientAssessment>>({});
  const [signedOut, setSignedOut] = useState(false);
  const [notificationPreferences, setNotificationPreferences] = useState(initialNotificationPreferences);
  const [riskReviews, setRiskReviews] = useState<Record<string, PatientRisk>>({});
  const [requests, setRequests] = useState<HomecareRequest[]>(homecareRequests);
  const [visits, setVisits] = useState<NurseVisit[]>(initialVisits);
  const [medicalRecords, setMedicalRecords] = useState<
    Record<string, VisitMedicalRecord>
  >(initialMedicalRecords);
  const [visitDrafts, setVisitDrafts] =
    useState<Record<string, VisitMedicalRecord>>(initialVisitDrafts);
  const [reviewedPatients, setReviewedPatients] = useState<string[]>([]);
  const [notifications, setNotifications] = useState(initialNotifications);
  const [toast, setToast] = useState("");

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(""), 4500);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  function decideRequest(
    id: string,
    status: Exclude<RequestStatus, "pending">,
    reason?: string,
  ) {
    setRequests((previous) =>
      previous.map((request) =>
        request.id === id && request.status === "pending"
          ? {
              ...request,
              status,
              rejectionReason:
                status === "rejected" ? reason?.trim() : undefined,
            }
          : request,
      ),
    );
  }

  function saveMedicalRecord(visitId: string, record: VisitMedicalRecord) {
    if (
      !visits.some(
        (visit) => visit.id === visitId && visit.status === "scheduled" && visit.date <= visitDemoDate,
      )
    )
      return false;
    if (!getRecordCompleteness(record).every((section) => section.complete))
      return false;
    setMedicalRecords((previous) => ({
      ...previous,
      [visitId]: record,
    }));
    setVisits((previous) =>
      previous.map((visit) =>
        visit.id === visitId ? { ...visit, status: "done" } : visit,
      ),
    );
    setVisitDrafts((previous) => {
      const next = { ...previous };
      delete next[visitId];
      return next;
    });
    return true;
  }

  function saveVisitDraft(visitId: string, record: VisitMedicalRecord) {
    if (
      !visits.some(
        (visit) => visit.id === visitId && visit.status === "scheduled",
      )
    )
      return false;
    setVisitDrafts((previous) => ({ ...previous, [visitId]: record }));
    return true;
  }

  function signOutDemo() {
    setPatientHistories(initialPatientHistories);
    setPatientAssessments({});
    setSignedOut(true);
    setNotificationPreferences(initialNotificationPreferences);
    setRiskReviews({});
    setRequests(homecareRequests);
    setVisits(initialVisits);
    setMedicalRecords(initialMedicalRecords);
    setVisitDrafts(initialVisitDrafts);
    setReviewedPatients([]);
    setNotifications(initialNotifications);
    setToast("");
  }

  return (
    <NurseDataContext.Provider
      value={{
        patientHistories,
        savePatientHistory: (patientId, history) => {
          if (!patientDirectory.some((item) => item.patient.id === patientId) || !isValidPatientHistory(history)) return false;
          const cleaned = Object.fromEntries(Object.entries(history).map(([key, value]) => [key, value.trim()])) as PatientMedicalHistory;
          setPatientHistories((previous) => ({ ...previous, [patientId]: cleaned }));
          return true;
        },
        patientAssessments,
        approvePatientAssessment: (patientId, assessment) => {
          if (!patientDirectory.some((item) => item.patient.id === patientId) || !assessment.summary.trim()) return false;
          setPatientAssessments((previous) => ({ ...previous, [patientId]: { ...assessment, summary: assessment.summary.trim() } }));
          setRiskReviews((previous) => ({ ...previous, [patientId]: assessment.risk }));
          return true;
        },
        notificationPreferences,
        setNotificationPreference: (setting, enabled) => setNotificationPreferences((previous) => ({ ...previous, [setting]: enabled })),
        unreadNotificationCount: notifications.filter((notification) => !notification.read).length,
        signOutDemo,
        riskReviews,
        approvePatientRisk: (patientId, risk) => {
          if (patientDirectory.some((item) => item.patient.id === patientId)) {
            setRiskReviews((previous) => ({ ...previous, [patientId]: risk }));
          }
        },
        visits,
        medicalRecords,
        visitDrafts,
        saveVisitDraft,
        saveMedicalRecord,
        requests,
        decideRequest,
        reviewedPatients,
        reviewPatient: (id) =>
          setReviewedPatients((previous) =>
            previous.includes(id) ? previous : [...previous, id],
          ),
        notifications,
        markNotificationRead: (notificationId) => setNotifications((previous) => previous.map((notification) => notification.id === notificationId ? { ...notification, read: true } : notification)),
        markNotificationsRead: () => setNotifications((previous) => previous.map((notification) => notification.read ? notification : { ...notification, read: true })),
        notify: setToast,
      }}
    >
      {signedOut ? <main className="demo-signout" aria-labelledby="signed-out-title">
        <div className="demo-signout-card">
          <Image src="/forcare-mark.svg" alt="ForCare" width={56} height={56} />
          <h1 id="signed-out-title">Anda telah keluar</h1>
          <p>Sesi demo lokal telah berakhir.</p>
          <button className="button button-primary" autoFocus onClick={() => setSignedOut(false)}>Masuk kembali sebagai {nurse.firstName}</button>
        </div>
      </main> : children}
      <div
        role="status"
        aria-live="polite"
        className={`toast${toast ? " is-visible" : ""}`}
      >
        {toast && (
          <>
            <CheckCircle2 size={20} aria-hidden="true" />
            <span>{toast}</span>
          </>
        )}
      </div>
    </NurseDataContext.Provider>
  );
}

export function useNurseData() {
  const context = useContext(NurseDataContext);
  if (!context)
    throw new Error("useNurseData must be used inside NurseDataProvider");
  return context;
}
