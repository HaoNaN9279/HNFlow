export interface Translations {
  // Locale meta
  locale: {
    localName: string;
  };

  // Common
  common: {
    home: string;
    settings: string;
    delete: string;
    edit: string;
    rename: string;
    renameFailed: string;
    share: string;
    openInNewWindow: string;
    close: string;
    more: string;
    search: string;
    loadMore: string;
    download: string;
    thinking: string;
    public: string;
    custom: string;
    notAvailableInDemoMode: string;
    loading: string;
    version: string;
    lastUpdated: string;
    code: string;
    preview: string;
    cancel: string;
    save: string;
    install: string;
    create: string;
    import: string;
    export: string;
    exportAsMarkdown: string;
    exportAsJSON: string;
    exportSuccess: string;
    exportFailed: string;
    regenerate: string;
    editAndRerun: string;
    updateAndRerun: string;
    editRerunWarning: string;
    branch: string;
  };

  runDuration: {
    reasoning: string;
    working: string;
    completedIn: (duration: string) => string;
    description: string;
    lessThanSecond: string;
    hours: (value: number) => string;
    minutes: (value: number) => string;
    seconds: (value: number) => string;
    separator: string;
  };

  home: {
    docs: string;
  };

  // Welcome
  clipboard: {
    copyToClipboard: string;
    copiedToClipboard: string;
    failedToCopyToClipboard: string;
    linkCopied: string;
  };

  artifactEditing: {
    unsaved: string;
    saving: string;
    saved: string;
    exit: string;
    discard: string;
    discardChanges: string;
    conflict: string;
    conflictShort: string;
    runInProgress: string;
    saveFailed: string;
  };

  artifactPreview: {
    limited: (previewSize: string, totalSize?: string) => string;
    loadFullFile: string;
    loadingFullFile: string;
    previewFailed: string;
  };

  // Citations
  citations: {
    sourcesSummary: (count: number) => string;
    citeCount: (count: number) => string;
    copyReference: (title: string) => string;
    copiedReference: (title: string) => string;
  };

  // Workspace Changes
  workspaceChanges: {
    title: string;
    editedTitle: (count: number) => string;
    badge: (count: number, additions: number, deletions: number) => string;
    viewChanges: string;
    created: string;
    modified: string;
    deleted: string;
    openFile: string;
    loading: string;
    noChanges: string;
    diffUnavailable: string;
    binaryUnavailable: string;
    largeUnavailable: string;
    sensitiveUnavailable: string;
    truncatedUnavailable: string;
    symlinkUnavailable: string;
    truncatedSummary: string;
  };

  // Input Box
  inputBox: {
    placeholder: string;
    disclaimer: string;
    createSkillPrompt: string;
    addAttachments: string;
    voiceInputStartLabel: string;
    voiceInputStopLabel: string;
    voiceInputStart: string;
    voiceInputStop: string;
    voiceInputListening: string;
    voiceInputUnsupported: string;
    voiceInputPermissionDenied: string;
    voiceInputMicrophoneUnavailable: string;
    voiceInputUnsupportedLanguage: string;
    voiceInputNetworkError: string;
    voiceInputNoSpeech: string;
    voiceInputFailed: string;
    searchModels: string;
    suggestionPlaceholderRequired: string;
    goalCommandDescription: string;
    compactCommandDescription: string;
    goalLabel: string;
    goalContinuing: string;
    goalContinuationTooltip: string;
    goalSet: string;
    goalCleared: string;
    goalNone: string;
    goalActive: string;
    goalFailed: string;
    goalTooLong: string;
    goalLengthCounter: string;
    compactSuccess: string;
    compactSkipped: string;
    compactFailed: string;
    pleaseWaitStreaming: string;
  };

  // Sidebar
  sidebar: {
    newChat: string;
    scheduledTasks: string;
    capabilityGroups: string;
    tools: string;
    models: string;
  };

  capabilityGroups: {
    title: string;
    description: string;
    loading: string;
    loadFailed: string;
    retry: string;
    empty: string;
    emptyHint: string;
    loadingContents: string;
    loadContentsFailed: string;
    noFiles: string;
    toolReferences: string;
    toolPermissions: string;
    reveal: string;
    revealGroup: string;
    revealFailed: string;
    revealed: string;
    repositoryMissing: string;
    activeSummary: (active: number, total: number) => string;
    core: string;
    active: string;
    inactive: string;
    coreOnlyHint: string;
    source: { vibestack: string };
    categories: {
      rules: string;
      agents: string;
      skills: string;
      tools: string;
      references: string;
      templates: string;
      assets: string;
      evals: string;
      other: string;
    };
  };

  tools: {
    title: string;
    description: string;
    loading: string;
    loadFailed: string;
    retry: string;
    empty: string;
    emptyHint: string;
    searchPlaceholder: string;
    noMatches: string;
    permissions: string;
    unknownPermissions: string;
    source: { package: string; provider: string };
    providers: {
      mcp: string;
      builtin: string;
      sandbox: string;
      app: string;
      python: string;
    };
  };

  modelProfiles: {
    title: string;
    description: string;
    loading: string;
    loadFailed: string;
    retry: string;
    empty: string;
    emptyHint: string;
    create: string;
    createTitle: string;
    editTitle: string;
    nameLabel: string;
    namePlaceholder: string;
    nameHint: string;
    displayNameLabel: string;
    displayNamePlaceholder: string;
    descriptionLabel: string;
    descriptionPlaceholder: string;
    targetModelLabel: string;
    targetModelPlaceholder: string;
    enabledLabel: string;
    enabledHint: string;
    save: string;
    saving: string;
    cancel: string;
    delete: string;
    deleteTitle: string;
    deleteConfirm: (name: string) => string;
    deleteBlocked: (workflows: number) => string;
    created: string;
    updated: string;
    deleted: string;
    saveFailed: string;
    deleteFailed: string;
    targetMissing: string;
    disabled: string;
    referencedBy: (count: number) => string;
    noModels: string;
    noModelsHint: string;
    nameInvalid: string;
    targetRequired: string;
  };

  // Scheduled tasks
  scheduledTasks: {
    scheduleType: { cron: string; once: string };
    preset: {
      label: string;
      hourly: string;
      daily: string;
      weekly: string;
      monthly: string;
      custom: string;
    };
    fields: {
      minute: string;
      time: string;
      weekday: string;
      dayOfMonth: string;
      cron: string;
      cronPlaceholder: string;
      runAt: string;
      timezone: string;
    };
    weekdays: {
      mon: string;
      tue: string;
      wed: string;
      thu: string;
      fri: string;
      sat: string;
      sun: string;
    };
    preview: string;
    cronHelp: string;
    create: {
      title: string;
      taskTitle: string;
      prompt: string;
      submit: string;
      fillRequired: string;
    };
    context: {
      fresh: string;
      reuse: string;
      threadIdPlaceholder: string;
    };
    filters: {
      allStatuses: string;
      enabled: string;
      paused: string;
      completed: string;
      failed: string;
      allTypes: string;
      cron: string;
      once: string;
    };
    detail: {
      contextMode: string;
      thread: string;
      lastThread: string;
      schedule: string;
      nextRun: string;
      lastRun: string;
      lastRunId: string;
      lastError: string;
      runsCount: string;
      runsCountOne: string;
      noRuns: string;
      noSelection: string;
      filteredByThread: string;
      loadFailed: string;
    };
    actions: {
      edit: string;
      cancelEdit: string;
      pause: string;
      resume: string;
      trigger: string;
      delete: string;
    };
    deleteConfirm: string;
    errors: {
      create: string;
      update: string;
      pause: string;
      resume: string;
      trigger: string;
      delete: string;
    };
    edit: {
      titlePlaceholder: string;
      promptPlaceholder: string;
      submit: string;
    };
    status: {
      enabled: string;
      paused: string;
      running: string;
      completed: string;
      failed: string;
      cancelled: string;
    };
    runTrigger: { scheduled: string; manual: string };
    runStatus: {
      queued: string;
      running: string;
      success: string;
      failed: string;
      skipped: string;
      interrupted: string;
    };
    recipes: {
      label: string;
      trending: { title: string; desc: string };
      news: { title: string; desc: string };
      issues: { title: string; desc: string };
      weekly: { title: string; desc: string };
    };
  };

  // Workflows
  workflows: {
    title: string;
    empty: string;
    create: string;
    createTitle: string;
    nameLabel: string;
    namePlaceholder: string;
    deleteConfirm: (name: string) => string;
    folders: {
      root: string;
      newFolder: string;
      newFolderTitle: string;
      folderName: string;
      createIn: (name: string) => string;
      rename: string;
      renameTitle: string;
      delete: string;
      deleteConfirm: (name: string) => string;
      newWorkflow: string;
      move: string;
      moveTitle: string;
      moveTarget: string;
      empty: string;
      loadFailed: string;
    };
    save: string;
    saving: string;
    unsaved: string;
    readonly: string;
    collapsePanel: string;
    expandPanel: string;
    resizePanel: string;
    backToDirectory: string;
    renameNodeHint: string;
    leave: {
      title: string;
      description: string;
      save: string;
      discard: string;
    };
    nodeCatalog: {
      title: string;
      hint: string;
      searchPlaceholder: string;
      empty: string;
    };
    contextMenu: {
      copy: string;
      cut: string;
      paste: string;
      subworkflowGlobal: string;
      subworkflowLocal: string;
    };
    categories: {
      flow: string;
      data: string;
      tool: string;
      ai: string;
      human: string;
      subworkflow: string;
      app: string;
    };
    properties: {
      title: string;
      paramsTitle: string;
      portsTitle: string;
      inputs: string;
      outputs: string;
      deleteNode: string;
      paramKey: string;
      paramValue: string;
      addParam: string;
      removeParam: string;
      nodeIdLabel: string;
      nodeTypeLabel: string;
      noSelection: string;
      params: {
        fields: Record<string, string>;
        invalidValue: string;
        jsonHint: string;
      };
      ai: {
        title: string;
        agentLabel: string;
        agentNoneOption: string;
        agentHint: string;
        modelProfileLabel: string;
        modelProfileNoneOption: string;
        modelProfileHint: string;
        modelProfileMissing: string;
        capabilityGroupsLabel: string;
        capabilityGroupsPlaceholder: string;
        continuePromptLabel: string;
        continuePromptHint: string;
        configTitle: string;
        promptComposition: {
          title: string;
          hint: string;
          loading: string;
          loadFailed: string;
          retry: string;
          tokens: string;
          sections: { system: string; task: string };
          states: {
            runtime: string;
            dropped: string;
            truncated: string;
          };
          sources: {
            identity: string;
            capability: string;
            capability_rules: string;
            capability_skills: string;
            schema_contract: string;
            input_schema: string;
            schema: string;
            template_prompt: string;
          };
          runtimeUnavailable: string;
        };
      };
      schema: {
        title: string;
        hint: string;
        commonTitle: string;
        commonHint: string;
        commonFieldHints: {
          summary: string;
          status: string;
          content: string;
          artifacts: string;
          metadata: string;
          error: string;
        };
        customTitle: string;
        addField: string;
        noFields: string;
        invalid: string;
        name: string;
        type: string;
        required: string;
        optional: string;
        description: string;
        descriptionPlaceholder: string;
        enumValues: string;
        enumValuesPlaceholder: string;
        removeField: string;
        maxRepairs: string;
        rawJson: string;
      };
      capabilityGroup: {
        title: string;
        groupLabel: string;
        groupPlaceholder: string;
        noGroups: string;
        mergeTitle: string;
        addInput: string;
        removeInput: string;
        inputLabel: string;
        promptPreviewTitle: string;
        promptPreviewAgent: string;
        promptPreviewAgentPlaceholder: string;
        previewButton: string;
        previewing: string;
        previewFailed: string;
        previewEmpty: string;
        runtimeOmitted: string;
      };
      subworkflow: {
        title: string;
        templateLabel: string;
        templatePlaceholder: string;
        modeLabel: string;
        versionLabel: string;
        noTemplates: string;
        mappingTitle: string;
        inputMappingLabel: string;
        outputMappingLabel: string;
        unmappedPlaceholder: string;
        openButton: string;
        saveModeLabel: string;
        saveModeGlobal: string;
        saveModeLocal: string;
        localSnapshotLabel: string;
        savedToParent: string;
        embeddedRunDisabled: string;
        embeddedNotFound: string;
        discardLocalConfirm: string;
        modeChangeFailed: string;
      };
      app: {
        title: string;
        appLabel: string;
        appPlaceholder: string;
        scriptLabel: string;
        scriptPlaceholder: string;
        scriptHint: string;
      };
      validation: {
        templateRequired: string;
        invalidAgentName: string;
        agentNotFoundWarning: string;
        mappingInvalid: string;
        appRequired: string;
      };
    };
    run: {
      run: string;
      runDisabled: string;
      stop: string;
      running: string;
      stopping: string;
      runSuccess: string;
      runFailed: string;
      cancelFailed: string;
      history: string;
      historyEmpty: string;
      historyLoadFailed: string;
      memoryBackendUnavailable: string;
      runStatus: {
        pending: string;
        running: string;
        success: string;
        error: string;
        timeout: string;
        interrupted: string;
      };
      nodeStatus: {
        idle: string;
        running: string;
        completed: string;
        failed: string;
      };
      continueSession: string;
      continuePromptPlaceholder: string;
      continuePromptSubmit: string;
      continueCancel: string;
      continueStarted: (runId: string) => string;
      step: string;
      stepHint: string;
      rewind: string;
      rewindHint: string;
      rewindStarted: (runId: string) => string;
      rewindFailed: string;
      humanTask: {
        title: string;
        task: string;
        runHint: (runId: string) => string;
        noFields: string;
        submit: string;
        skip: string;
        skipHint: string;
        required: string;
        optional: string;
        true: string;
        false: string;
        patternHint: string;
      };
      review: {
        title: string;
        runHint: (runId: string) => string;
        attempt: (visit: number) => string;
        previousRejections: (count: number) => string;
        target: (nodeId: string) => string;
        instructions: string;
        input: string;
        approve: string;
        reject: string;
        feedback: string;
        feedbackHint: string;
        submit: string;
        submitting: string;
        actionFailed: string;
        loadFailed: string;
        retry: string;
      };
      debugPause: {
        title: string;
        hint: string;
        step: string;
        runHint: (runId: string) => string;
        continue: string;
        skip: string;
        continued: string;
        skipped: string;
        actionFailed: string;
        loadFailed: string;
        retry: string;
      };
      panel: {
        title: string;
        idleHint: string;
        timeline: string;
        slowestNode: string;
        output: string;
        noOutput: string;
        errorDetail: string;
        terminalStatus: string;
      };
    };
    errors: {
      loadFailed: string;
      saveFailed: string;
      saveSuccess: string;
      deleteFailed: string;
      validationPrefix: string;
      portTypeMismatch: string;
      portAlreadyConnected: string;
      selfConnection: string;
      missingPort: string;
    };
  };

  // Projects (file-backed project directories)
  projects: {
    title: string;
    description: string;
    empty: string;
    open: string;
    openTitle: string;
    openHint: string;
    openExisting: string;
    createNew: string;
    openWorkbenches: string;
    pathLabel: string;
    pathPlaceholder: string;
    nameLabel: string;
    namePlaceholder: string;
    loadFailed: string;
    close: string;
    closeConfirm: (name: string) => string;
  };

  // Workbenches (saved project monitoring surfaces)
  workbenches: {
    title: string;
    description: string;
    empty: string;
    create: string;
    createTitle: string;
    nameLabel: string;
    namePlaceholder: string;
    descriptionLabel: string;
    descriptionPlaceholder: string;
    deleteConfirm: (name: string) => string;
    loadFailed: string;
    open: string;
    members: (count: number) => string;
    created: string;
    createFailed: string;
    saveFailed: string;
    deleteFailed: string;
    back: string;
    addMember: string;
    addMemberTitle: string;
    addMemberHint: string;
    noAvailableWorkflows: string;
    removeMember: string;
    removeConfirm: (name: string) => string;
    run: string;
    step: string;
    cancel: string;
    edit: string;
    noMembers: string;
    noMembersHint: string;
    runStarted: string;
    runFailed: string;
    cancelFailed: string;
    memberAdded: string;
    memberAddFailed: string;
    memberRemoved: string;
    memberRemoveFailed: string;
    activeRun: string;
    noActiveRun: string;
    pendingHuman: string;
    currentNode: string;
    elapsed: string;
    completed: string;
    unassignedWorkbench: string;
  };

  // Persistent Lead Agent panel
  leadAgent: {
    title: string;
    history: string;
    newChat: string;
    collapse: string;
    expand: string;
    resize: string;
    emptyHistory: string;
    skillMenu: string;
    skillMenuEmpty: string;
    skillActive: string;
    clearSkill: string;
    undo: string;
    undoUnavailable: string;
    undoConfirmTitle: string;
    undoConfirmDescription: (count: number) => string;
    undoAction: string;
    undoSuccess: (count: number) => string;
    undoConflict: string;
    changeHistory: string;
    changeHistoryEmpty: string;
    changeHistoryDescription: string;
    changeApplied: string;
    changeUndone: string;
  };

  // Persistent global workflow monitor
  runMonitor: {
    title: string;
    collapse: string;
    expand: string;
    resize: string;
    loading: string;
    empty: string;
    loadFailed: string;
    retry: string;
    pendingTitle: string;
    pendingEmpty: string;
    pendingLoadFailed: string;
    review: string;
    task: string;
    stepPause: string;
    continue: string;
    skip: string;
    actionFailed: string;
    openWorkbench: string;
    active: string;
    waitingHuman: string;
    unassigned: string;
    currentNode: string;
    completed: string;
    elapsed: string;
  };

  breadcrumb: {
    workspace: string;
    workflows: string;
    tools: string;
  };

  // Workspace
  workspace: {
    githubTooltip: string;
    settingsAndMore: string;
  };

  // Conversation
  conversation: {
    noMessages: string;
    startConversation: string;
    branchCreated: string;
    branchFailed: string;
    streamReplayGap: string;
  };

  // Chats
  chats: {
    searchChats: string;
    loadMoreToSearch: string;
    loadingMore: string;
    loadOlderChats: string;
    pinChat: string;
    unpinChat: string;
    pinChatFailed: string;
  };

  pages: {
    appName: string;
    newChat: string;
    untitled: string;
  };

  // Tool calls
  toolCalls: {
    moreSteps: (count: number) => string;
    lessSteps: string;
    executeCommand: string;
    presentFiles: string;
    needYourHelp: string;
    useTool: (toolName: string) => string;
    searchForRelatedInfo: string;
    searchForRelatedImages: string;
    searchFor: (query: string) => string;
    searchForRelatedImagesFor: (query: string) => string;
    searchOnWebFor: (query: string) => string;
    viewWebPage: string;
    listFolder: string;
    readFile: string;
    writeFile: string;
    clickToViewContent: string;
    writeTodos: string;
    skillInstallTooltip: string;
    browserNavigate: (url: string) => string;
    browserNavigateGeneric: string;
    browserClick: string;
    browserType: string;
    browserSnapshot: string;
    browserGetText: string;
    browserBack: string;
    browserScreenshot: string;
    browserClose: string;
  };

  humanInput: {
    answered: string;
    pending: string;
    readOnly: string;
    otherLabel: string;
    otherPlaceholder: string;
    submit: string;
    emptyError: string;
    requiredError: string;
    requiredA11yLabel: string;
    selectPlaceholder: string;
    answeredValue: (value: string) => string;
  };

  // Uploads
  uploads: {
    uploading: string;
    uploadingFiles: string;
    limitsHint: (
      maxFiles: number,
      maxFileSize: string,
      maxTotalSize: string,
    ) => string;
    filesTooLarge: (files: string, maxFileSize: string) => string;
    tooManyFiles: (count: number, maxFiles: number) => string;
    totalSizeTooLarge: (count: number, maxTotalSize: string) => string;
  };

  // Subtasks
  subtasks: {
    subtask: string;
    executing: (count: number) => string;
    in_progress: string;
    completed: string;
    failed: string;
  };

  // Token Usage
  tokenUsage: {
    title: string;
    label: string;
    input: string;
    output: string;
    total: string;
    view: string;
    unavailable: string;
    unavailableShort: string;
    collecting: string;
    note: string;
    presets: {
      off: string;
      summary: string;
      perTurn: string;
      debug: string;
    };
    presetDescriptions: {
      off: string;
      summary: string;
      perTurn: string;
      debug: string;
    };
    finalAnswer: string;
    stepTotal: string;
    sharedAttribution: string;
    subagent: (description: string) => string;
    startTodo: (content: string) => string;
    completeTodo: (content: string) => string;
    updateTodo: (content: string) => string;
    removeTodo: (content: string) => string;
  };

  contextUsage: {
    label: string;
    title: string;
    badgeAriaLabel: (percentage: string) => string;
  };

  // Shortcuts
  shortcuts: {
    searchActions: string;
    noResults: string;
    actions: string;
    keyboardShortcuts: string;
    keyboardShortcutsDescription: string;
    openCommandPalette: string;
    toggleSidebar: string;
  };

  // Settings
  settings: {
    title: string;
    description: string;
    sections: {
      account: string;
      appearance: string;
      memory: string;
      tools: string;
      skills: string;
      notification: string;
    };
    memory: {
      title: string;
      description: string;
      empty: string;
      rawJson: string;
      exportButton: string;
      exportSuccess: string;
      importButton: string;
      importConfirmTitle: string;
      importConfirmDescription: string;
      importFileLabel: string;
      importInvalidFile: string;
      importSuccess: string;
      manualFactSource: string;
      addFact: string;
      addFactTitle: string;
      editFactTitle: string;
      addFactSuccess: string;
      editFactSuccess: string;
      clearAll: string;
      clearAllConfirmTitle: string;
      clearAllConfirmDescription: string;
      clearAllSuccess: string;
      factDeleteConfirmTitle: string;
      factDeleteConfirmDescription: string;
      factDeleteSuccess: string;
      factContentLabel: string;
      factCategoryLabel: string;
      factConfidenceLabel: string;
      factContentPlaceholder: string;
      factCategoryPlaceholder: string;
      factConfidenceHint: string;
      factSave: string;
      factValidationContent: string;
      factValidationConfidence: string;
      noFacts: string;
      summaryReadOnly: string;
      memoryFullyEmpty: string;
      factPreviewLabel: string;
      searchPlaceholder: string;
      filterAll: string;
      filterFacts: string;
      filterSummaries: string;
      noMatches: string;
      markdown: {
        overview: string;
        userContext: string;
        work: string;
        personal: string;
        topOfMind: string;
        historyBackground: string;
        recentMonths: string;
        earlierContext: string;
        longTermBackground: string;
        updatedAt: string;
        facts: string;
        empty: string;
        table: {
          category: string;
          confidence: string;
          confidenceLevel: {
            veryHigh: string;
            high: string;
            normal: string;
            unknown: string;
          };
          content: string;
          source: string;
          createdAt: string;
          view: string;
        };
      };
    };
    appearance: {
      themeTitle: string;
      themeDescription: string;
      system: string;
      light: string;
      dark: string;
      systemDescription: string;
      lightDescription: string;
      darkDescription: string;
      languageTitle: string;
      languageDescription: string;
    };
    tools: {
      title: string;
      description: string;
      adminRequired: string;
      empty: string;
    };
    skills: {
      title: string;
      description: string;
      createSkill: string;
      emptyTitle: string;
      emptyDescription: string;
      emptyButton: string;
      adminRequired: string;
      installAdminRequired: string;
    };
    notification: {
      title: string;
      description: string;
      requestPermission: string;
      deniedHint: string;
      testButton: string;
      testTitle: string;
      testBody: string;
      notSupported: string;
      disableNotification: string;
    };
    account: {
      profileTitle: string;
      email: string;
      role: string;
      changePasswordTitle: string;
      changePasswordDescription: string;
      ssoProvider: string;
      ssoPasswordDescription: string;
      ssoPasswordMessage: string;
      currentPassword: string;
      newPassword: string;
      confirmNewPassword: string;
      passwordMismatch: string;
      passwordTooShort: string;
      passwordChangedSuccess: string;
      networkError: string;
      updating: string;
      updatePassword: string;
      signOut: string;
    };
    acknowledge: {
      emptyTitle: string;
      emptyDescription: string;
    };
  };

  // Login / Auth
  login: {
    signInTitle: string;
    createAccountTitle: string;
    email: string;
    emailPlaceholder: string;
    password: string;
    passwordPlaceholder: string;
    rememberMe: string;
    rememberMeDescription: string;
    pleaseWait: string;
    signIn: string;
    createAccount: string;
    createAdminAccount: string;
    adminSetupRequiredTitle: string;
    adminSetupRequiredDescription: string;
    orContinueWith: string;
    ssoHint: string;
    continueWith: (provider: string) => string;
    noAccountSignUp: string;
    haveAccountSignIn: string;
    backToHome: string;
    networkError: string;
    serviceUnavailableTitle: string;
    serviceUnavailableDescription: string;
    retry: string;
    authFailed: string;
    errors: {
      sso_failed: string;
      sso_cancelled: string;
      sso_account_exists: string;
      sso_not_allowed: string;
    };
  };
}
