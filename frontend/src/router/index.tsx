import{lazy,Suspense}from'react';
import{createBrowserRouter,Navigate}from'react-router-dom';
import{ProtectedRoute}from'./ProtectedRoute';
import{ProfileGuard}from'./ProfileGuard';
import{WorkspaceGuard}from'./WorkspaceGuard';
import{AdminRoute}from'./AdminRoute';
import{Spinner}from'@/components/ui/Spinner';
import{AppLayout}from'@/components/layout/AppLayout';
import{AuthLayout}from'@/components/layout/AuthLayout';
import{PublicLayout}from'@/components/layout/PublicLayout';
const Load=()=><div className="flex h-screen items-center justify-center"><Spinner size="lg"/></div>;
const S=(C:React.LazyExoticComponent<()=>JSX.Element>)=><Suspense fallback={<Load/>}><C/></Suspense>;
const LoginPage=lazy(()=>import('@/pages/auth/LoginPage'));
const SignupPage=lazy(()=>import('@/pages/auth/SignupPage'));
const VerifyEmailPage=lazy(()=>import('@/pages/auth/VerifyEmailPage'));
const ForgotPasswordPage=lazy(()=>import('@/pages/auth/ForgotPasswordPage'));
const ResetPasswordPage=lazy(()=>import('@/pages/auth/ResetPasswordPage'));
const CallbackPage=lazy(()=>import('@/pages/auth/CallbackPage'));
const RegisterPage=lazy(()=>import('@/pages/auth/RegisterPage'));
const InvitePage=lazy(()=>import('@/pages/public/InvitePage'));
const PublicContainerPage=lazy(()=>import('@/pages/public/PublicContainerPage'));
const WorkspaceSelectPage=lazy(()=>import('@/pages/workspace/WorkspaceSelectPage'));
const CreateWorkspacePage=lazy(()=>import('@/pages/workspace/CreateWorkspacePage'));
const DashboardPage=lazy(()=>import('@/pages/dashboard/DashboardPage'));
const ContainerListPage=lazy(()=>import('@/pages/containers/ContainerListPage'));
const ContainerDetailPage=lazy(()=>import('@/pages/containers/ContainerDetailPage'));
const ContainerLedgerPage=lazy(()=>import('@/pages/containers/ContainerLedgerPage'));
const ContainerTasksPage=lazy(()=>import('@/pages/containers/ContainerTasksPage'));
const ContainerParticipantsPage=lazy(()=>import('@/pages/containers/ContainerParticipantsPage'));
const ContainerCyclesPage=lazy(()=>import('@/pages/containers/ContainerCyclesPage'));
const ContainerSummaryPage=lazy(()=>import('@/pages/containers/ContainerSummaryPage'));
const MemberListPage=lazy(()=>import('@/pages/members/MemberListPage'));
const MemberDetailPage=lazy(()=>import('@/pages/members/MemberDetailPage'));
const GroupsPage=lazy(()=>import('@/pages/groups/GroupsPage'));
const DisputeListPage=lazy(()=>import('@/pages/disputes/DisputeListPage'));
const DisputeDetailPage=lazy(()=>import('@/pages/disputes/DisputeDetailPage'));
const TimelinePage=lazy(()=>import('@/pages/timeline/TimelinePage'));
const NotificationsPage=lazy(()=>import('@/pages/notifications/NotificationsPage'));
const ProfileSettingsPage=lazy(()=>import('@/pages/settings/ProfileSettingsPage'));
const WorkspaceSettingsPage=lazy(()=>import('@/pages/settings/WorkspaceSettingsPage'));
const NotifSettingsPage=lazy(()=>import('@/pages/settings/NotificationSettingsPage'));
export const router=createBrowserRouter([
  {path:'/',element:<Navigate to="/login" replace/>},
  {element:<AuthLayout/>,children:[
    {path:'/login',element:S(LoginPage)},{path:'/signup',element:S(SignupPage)},
    {path:'/signup/verify-email',element:S(VerifyEmailPage)},{path:'/auth/forgot-password',element:S(ForgotPasswordPage)},
    {path:'/auth/reset-password',element:S(ResetPasswordPage)},{path:'/auth/callback',element:S(CallbackPage)},
    {path:'/register',element:S(RegisterPage)},
  ]},
  {element:<PublicLayout/>,children:[{path:'/invite/:token',element:S(InvitePage)},{path:'/p/:publicToken',element:S(PublicContainerPage)}]},
  {element:<ProtectedRoute/>,children:[{element:<ProfileGuard/>,children:[
    {path:'/workspace/select',element:S(WorkspaceSelectPage)},{path:'/workspace/create',element:S(CreateWorkspacePage)},
    {element:<WorkspaceGuard/>,children:[{element:<AppLayout/>,children:[
      {path:'/app/dashboard',element:S(DashboardPage)},
      {path:'/app/containers',element:S(ContainerListPage)},{path:'/app/containers/:id',element:S(ContainerDetailPage)},
      {path:'/app/containers/:id/ledger',element:S(ContainerLedgerPage)},{path:'/app/containers/:id/tasks',element:S(ContainerTasksPage)},
      {path:'/app/containers/:id/summary',element:S(ContainerSummaryPage)},
      {path:'/app/members',element:S(MemberListPage)},{path:'/app/members/:id',element:S(MemberDetailPage)},
      {path:'/app/timeline',element:S(TimelinePage)},{path:'/app/notifications',element:S(NotificationsPage)},
      {path:'/app/settings',element:S(ProfileSettingsPage)},{path:'/app/settings/notifications',element:S(NotifSettingsPage)},
      {element:<AdminRoute/>,children:[
        {path:'/app/containers/:id/participants',element:S(ContainerParticipantsPage)},
        {path:'/app/containers/:id/cycles',element:S(ContainerCyclesPage)},
        {path:'/app/groups',element:S(GroupsPage)},{path:'/app/disputes',element:S(DisputeListPage)},
        {path:'/app/disputes/:id',element:S(DisputeDetailPage)},{path:'/app/settings/workspace',element:S(WorkspaceSettingsPage)},
      ]},
    ]}]},
  ]}]},
  {path:'*',element:<Navigate to="/login" replace/>},
]);
